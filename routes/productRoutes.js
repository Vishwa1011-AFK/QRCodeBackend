const express = require('express');
const { signQRCodeBatch, updateBatchProducts, scanQRCodeUnified } = require('../controllers/productController');
const router = express.Router();

// Route for signing a batch of QR codes and generating a master QR code
router.post('/sign', signQRCodeBatch);

// Route for updating products in a batch with a master QR code scan location
router.post('/updateBatch', updateBatchProducts);

// Route for scanning individual product or master QR codes
router.post('/scan', scanQRCodeUnified);

module.exports = router;
