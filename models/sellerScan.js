const mongoose = require('mongoose');

const sellerScanSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    location: {
        latitude: {
            type: Number,
            required: true,
            min: -90,
            max: 90,
        },
        longitude: {
            type: Number,
            required: true,
            min: -180,
            max: 180,
        },
    },
    scannedAt: { type: Date, default: Date.now },
});

sellerScanSchema.index({ productId: 1 });

module.exports = mongoose.model('SellerScan', sellerScanSchema);