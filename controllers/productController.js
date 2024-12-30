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

// Add new endpoint for downloading ZIP file
const downloadBatchZip = async (req, res) => {
    const { batchId } = req.params;
    
    try {
        const products = await Product.find({ batchId });
        if (products.length === 0) {
            return res.status(404).json({ error: 'No products found for this batch' });
        }

        const tempDir = path.join(__dirname, '../temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

        const imagePaths = [];

        // Generate QR code images for each product
        for (const product of products) {
            const filePath = path.join(tempDir, `${product.uuid}.png`);
            await QRCode.toFile(filePath, product.signedQRCode);
            imagePaths.push(filePath);
        }

        // Generate master QR code
        const masterQRCode = await MasterQRCode.findOne({ batchId });
        if (masterQRCode) {
            const masterFilePath = path.join(tempDir, `master-${batchId}.png`);
            await QRCode.toFile(masterFilePath, masterQRCode.masterQRCode);
            imagePaths.push(masterFilePath);
        }

        // Create ZIP file
        const zipFilePath = path.join(tempDir, `batch-${batchId}.zip`);
        const output = fs.createWriteStream(zipFilePath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.pipe(output);

        // Add all images to the ZIP
        imagePaths.forEach((filePath) => {
            archive.file(filePath, { name: path.basename(filePath) });
        });

        await archive.finalize();

        // Send the ZIP file
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=batch-${batchId}.zip`);
        const fileStream = fs.createReadStream(zipFilePath);
        fileStream.pipe(res);

        // Clean up files after sending
        fileStream.on('close', () => {
            imagePaths.forEach((filePath) => fs.unlinkSync(filePath));
            fs.unlinkSync(zipFilePath);
        });

    } catch (error) {
        console.error('Error generating batch ZIP:', error);
        res.status(500).json({ error: 'Error generating batch ZIP file' });
    }
};

// Update the signQRCodeBatch function to not handle ZIP generation
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

        res.json({
            message: `${numberOfCodes} QR codes signed and stored successfully`,
            signedQRCodes,
            masterQRCode,
            batchId
        });
    } catch (error) {
        console.error('Error saving QR codes:', error);
        res.status(500).json({ error: 'Error signing QR codes' });
    }
};

module.exports = {
    signQRCodeBatch,
    scanQRCodeUnified,
    downloadBatchZip
};