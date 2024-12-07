const jwt = require('jsonwebtoken');
const Product = require('../models/product');
const Scan = require('../models/scan');

const SECRET_KEY = process.env.JWT_SECRET_KEY;

const signQRCode = (req, res) => {
    const { name, stationId, uuid } = req.body;

    const qrData = { name, stationId, uuid };
    const signedQRCode = jwt.sign(qrData, SECRET_KEY, { expiresIn: '1y' });

    const newProduct = new Product({
        name,
        stationId,
        uuid,
        signedQRCode,
        createdAt: new Date(),
    });

    newProduct
        .save()
        .then((product) => {
            res.json({
                message: 'QR code signed and stored successfully',
                signedQRCode,
                product,
            });
        })
        .catch((error) => {
            console.error('Error saving product:', error);
            res.status(500).json({ error: 'Error saving QR code to database' });
        });
};

const verifyQRCode = (req, res) => {
    const { signedQRCode } = req.body;

    try {
        const decodedData = jwt.verify(signedQRCode, SECRET_KEY);
        res.json({ message: 'QR code is valid', decodedData });
    } catch (error) {
        console.error('Invalid QR code:', error);
        res.status(400).json({ error: 'Invalid or expired QR code' });
    }
};

const scanQRCode = async (req, res) => {
    const { signedQRCode, location } = req.body;

    try {
        const decodedData = jwt.verify(signedQRCode, SECRET_KEY);

        const product = await Product.findOne({ uuid: decodedData.uuid });
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }

        const scan = new Scan({
            productId: product._id,
            location,
        });
        await scan.save();

        res.json({ message: 'Scan recorded successfully', product });
    } catch (error) {
        console.error('Error verifying scan:', error);
        res.status(400).json({ error: 'Invalid or expired QR code' });
    }
};

module.exports = { signQRCode, verifyQRCode, scanQRCode };
