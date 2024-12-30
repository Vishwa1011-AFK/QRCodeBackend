require('dotenv').config();
const jwt = require('jsonwebtoken');
const Product = require('../models/product');
const Scan = require('../models/scan');
const MasterQRCode = require('../models/masterQRCode'); // Importing the model for Master QR codes

const SECRET_KEY = process.env.AES_SECRET_KEY;

const signQRCodeBatch = (req, res) => {
    const { name, stationId, numberOfCodes } = req.body;

    const batchId = uuidv4(); // Generate a unique batch ID
    const signedQRCodes = [];  // Array to store the signed QR codes

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

        // Save the product to the database
        newProduct.save().catch((error) => {
            console.error('Error saving product:', error);
            res.status(500).json({ error: 'Error saving QR code to database' });
        });
    }

    res.json({
        message: `${numberOfCodes} QR codes signed and stored successfully`,
        signedQRCodes,
    });
};

const generateMasterQRCode = async (req, res) => {
    const { batchId } = req.body;

    // Generate the master QR code data, containing only the batchId
    const qrData = { batchId };
    const masterQRCode = jwt.sign(qrData, SECRET_KEY, { expiresIn: '1y' });

    // Save the master QR code in the database (new step)
    const newMasterQRCode = new MasterQRCode({
        batchId,
        masterQRCode,
    });
    await newMasterQRCode.save();

    res.json({
        message: 'Master QR code generated and saved successfully',
        masterQRCode,
    });
};

const scanQRCodeUnified = async (req, res) => {
    const { signedQRCode, location } = req.body;

    try {
        const decodedData = jwt.verify(signedQRCode, SECRET_KEY);

        if (decodedData.batchId && !decodedData.uuid) {
            // This is a master QR code
            const { batchId } = decodedData;

            // Retrieve all products related to the batchId
            const products = await Product.find({ batchId });
            if (products.length === 0) {
                return res.status(404).json({ error: 'No products found for this batch' });
            }

            const { latitude, longitude } = location;
            const scanEntries = products.map(product => ({
                productId: product._id,
                location: { latitude, longitude },
            }));

            // Save scan entries for each product in the batch
            await Scan.insertMany(scanEntries);

            // Update the master QR code's scan record
            const masterQRCode = await MasterQRCode.findOne({ batchId });
            if (masterQRCode) {
                masterQRCode.scanRecords.push({
                    location: { latitude, longitude },
                    scannedAt: new Date(),
                });
                await masterQRCode.save();
            }

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

module.exports = { signQRCodeBatch, scanQRCodeUnified, generateMasterQRCode };
