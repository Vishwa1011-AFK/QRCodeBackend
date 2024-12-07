const express = require('express');
const { signQRCode, scanQRCode } = require('../controllers/productController');
const router = express.Router();

// Route for signing QR code
router.post('/sign', signQRCode);

// Route for verifying signed QR code
router.post('/scan', scanQRCode);

module.exports = router;
