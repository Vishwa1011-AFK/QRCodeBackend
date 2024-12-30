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

// Function to generate and send batch ZIP file
const generateBatchZip = async (req, res, batchId) => {
    try {
        // Fetch all products in the batch
        const products = await Product.find({ batchId });
        if (products.length === 0) {
            return res.status(404).json({ error: 'No products found for this batch' });
        }

        // Create a directory for temporary files
        const tempDir = path.join(__dirname, '../temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

        // Generate QR codes and save them as images
        const imagePaths = [];
        let masterFilePath = null;

        // Generate QR codes for all products and identify the master QR code
        for (const product of products) {
            const filePath = path.join(tempDir, `${product.uuid}.png`);

            // If this is the master product, save it with a unique identifier
            if (product.isMaster) {
                masterFilePath = filePath;  // Assign master file path for later reference
            }

            // Generate QR code image
            await QRCode.toFile(filePath, product.signedQRCode);
            imagePaths.push(filePath);
        }

        // Check if MasterQRCode exists for the batch
        let masterQRCode = await MasterQRCode.findOne({ batchId });

        // If not, create a new entry in the MasterQRCode collection
        if (!masterQRCode) {
            masterQRCode = new MasterQRCode({
                batchId,
                masterQRCode: masterFilePath, // You can store the path or the actual QR code data here
            });
            await masterQRCode.save();
        }

        // Create a ZIP file
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

        // Send the ZIP file to the frontend
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=batch-${batchId}.zip`);
        const fileStream = fs.createReadStream(zipFilePath);
        fileStream.pipe(res);

        // Clean up temporary files after response is sent
        fileStream.on('close', () => {
            imagePaths.forEach((filePath) => fs.unlinkSync(filePath));
            fs.unlinkSync(zipFilePath);
        });
    } catch (error) {
        console.error('Error generating batch ZIP:', error);
        res.status(500).json({ error: 'Error generating batch ZIP file' });
    }
};

// Function to sign a batch of QR codes and generate a master QR code
const signQRCodeBatch = async (req, res) => {
    const { name, stationId, numberOfCodes } = req.body;

    const batchId = uuidv4(); // Generate a unique batch ID
    const signedQRCodes = [];  // Array to store the signed QR codes

    try {
        // Loop to generate the requested number of QR codes
        for (let i = 0; i < numberOfCodes; i++) {
            const uuid = uuidv4(); // Generate a unique UUID for each product
            const qrData = { name, stationId, uuid };
            const signedQRCode = jwt.sign(qrData, SECRET_KEY, { expiresIn: '1y' });

            // Create a new product for each QR code
            const newProduct = new Product({
                name,
                stationId,
                uuid,
                signedQRCode,
                batchId,  // Assign the same batchId to all products in the batch
                createdAt: new Date(),
            });

            signedQRCodes.push(signedQRCode);
            await newProduct.save(); // Save the product to the database
        }

        // Generate the master QR code
        const masterQRData = { batchId };
        const masterQRCode = jwt.sign(masterQRData, SECRET_KEY, { expiresIn: '1y' });

        // Save the master QR code to the database
        const newMasterQRCode = new MasterQRCode({
            batchId,
            masterQRCode,
        });

        await newMasterQRCode.save();

        // After signing the QR codes, generate and send the ZIP file
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

// Unified function to scan individual or master QR codes
const scanQRCodeUnified = async (req, res) => {
    const { signedQRCode, location } = req.body;

    try {
        const decodedData = jwt.verify(signedQRCode, SECRET_KEY);

        if (decodedData.batchId && !decodedData.uuid) {
            // This is a master QR code
            const { batchId } = decodedData;

            // Call the logic for updating the batch products (this is already handled here)
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

            return res.json({ message: `All products in batch ${batchId} updated with scan location successfully` });
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

            return res.json({ message: 'Scan recorded successfully', product });
        }

        res.status(400).json({ error: 'Unrecognized QR code type' });
    } catch (error) {
        console.error('Error verifying QR code:', error);
        res.status(400).json({ error: 'Invalid or expired QR code' });
    }
};

// Export all functions
module.exports = {
    signQRCodeBatch,
    scanQRCodeUnified,
};
