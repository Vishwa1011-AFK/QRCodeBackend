const jwt = require('jsonwebtoken');
const Product = require('../models/product');

// Secret key for signing JWT (use a strong, secure key in .env)
const SECRET_KEY = process.env.JWT_SECRET_KEY || 'your-secret-key';

// Function to sign the QR code data
const signQRCode = (req, res) => {
    const { name, stationId, uuid } = req.body;

    // Create the QR code payload
    const qrData = { name, stationId, uuid };

    // Sign the QR code with the secret key
    const signedQRCode = jwt.sign(qrData, SECRET_KEY, { expiresIn: '1y' });

    // Save signed QR code data to the database
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

// Function to verify the signed QR code
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

module.exports = { signQRCode, verifyQRCode };
