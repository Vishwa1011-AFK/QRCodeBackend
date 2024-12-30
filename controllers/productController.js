require('dotenv').config();
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const archiver = require('archiver');
const Product = require('../models/product');
const Scan = require('../models/scan');
const MasterQRCode = require('../models/masterQRCode');

const SECRET_KEY = process.env.AES_SECRET_KEY;

const generateBatchZip = async (req, res, batchId) => {
    try {
        const products = await Product.find({ batchId });
        if (products.length === 0) {
            return res.status(404).json({ error: 'No products found for this batch' });
        }

        const tempDir = path.join(__dirname, '../temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

        const imagePaths = [];
        let masterFilePath = null;

        for (const product of products) {
            const filePath = path.join(tempDir, `${product.uuid}.png`);

            if (product.isMaster) {
                masterFilePath = filePath;
            }

            await QRCode.toFile(filePath, product.signedQRCode);
            imagePaths.push(filePath);
        }

        let masterQRCode = await MasterQRCode.findOne({ batchId });

        if (!masterQRCode) {
            masterQRCode = new MasterQRCode({
                batchId,
                masterQRCode: masterFilePath,
            });
            await masterQRCode.save();
        }

        const zipFilePath = path.join(tempDir, `batch-${batchId}.zip`);
        const output = fs.createWriteStream(zipFilePath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            console.log(`ZIP file created: ${archive.pointer()} total bytes`);
        });

        archive.on('error', (err) => {
            throw err;
        });

        archive.pipe(output);
        imagePaths.forEach((filePath) => {
            archive.file(filePath, { name: path.basename(filePath) });
        });

        await archive.finalize();

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=batch-${batchId}.zip`);
        const fileStream = fs.createReadStream(zipFilePath);
        fileStream.pipe(res);

        fileStream.on('close', () => {
            imagePaths.forEach((filePath) => fs.unlinkSync(filePath));
            fs.unlinkSync(zipFilePath);
        });
    } catch (error) {
        console.error('Error generating batch ZIP:', error);
        res.status(500).json({ error: 'Error generating batch ZIP file' });
    }
};

const signQRCodeBatch = async (req, res) => {
    const { name, stationId, numberOfCodes } = req.body;
    const batchId = uuidv4();
    const signedQRCodes = [];

    try {
        for (let i = 0; i < numberOfCodes; i++) {
            const uuid = uuidv4();
            const qrData = { name, stationId, uuid };
            const signedQRCode = jwt.sign(qrData, SECRET_KEY, { expiresIn: '1y' });

            const newProduct = new Product({
                name,
                stationId,
                uuid,
                signedQRCode,
                batchId,
                createdAt: new Date(),
            });

            signedQRCodes.push(signedQRCode);
            await newProduct.save();
        }

        const masterQRData = { batchId };
        const masterQRCode = jwt.sign(masterQRData, SECRET_KEY, { expiresIn: '1y' });

        const newMasterQRCode = new MasterQRCode({
            batchId,
            masterQRCode,
        });

        await newMasterQRCode.save();

        await generateBatchZip(req, res, batchId);

        res.json({
            message: `${numberOfCodes} QR codes signed and stored successfully`,
            signedQRCodes,
            masterQRCode,
        });
    } catch (error) {
        console.error('Error saving QR codes:', error);
        res.status(500).json({ error: 'Error signing QR codes' });
    }
};

const scanQRCodeUnified = async (req, res) => {
    const { signedQRCode, location } = req.body;

    try {
        const decodedData = jwt.verify(signedQRCode, SECRET_KEY);

        if (decodedData.batchId && !decodedData.uuid) {
            // This is a master QR code
            const { batchId } = decodedData;

            const products = await Product.find({ batchId });
            if (products.length === 0) {
                return res.status(404).json({ error: 'No products found for this batch' });
            }

            const { latitude, longitude } = location;
            const scanEntries = products.map(product => ({
                productId: product._id,
                location: { latitude, longitude },
            }));

            await Scan.insertMany(scanEntries);

            // Return batch data in the expected format
            return res.json({
                batch: {
                    batchId: batchId,
                    products: products.map(product => ({
                        name: product.name,
                        stationId: product.stationId,
                        uuid: product.uuid
                    }))
                }
            });
        }

        if (decodedData.uuid) {
            // This is an individual product QR code
            const product = await Product.findOne({ uuid: decodedData.uuid });
            if (!product) {
                return res.status(404).json({ error: 'Product not found' });
            }

            const scan = new Scan({
                productId: product._id,
                location,
            });
            await scan.save();

            return res.json({ product });
        }

        res.status(400).json({ error: 'Unrecognized QR code type' });
    } catch (error) {
        console.error('Error verifying QR code:', error);
        res.status(400).json({ error: 'Invalid or expired QR code' });
    }
};

module.exports = {
    signQRCodeBatch,
    scanQRCodeUnified,
};