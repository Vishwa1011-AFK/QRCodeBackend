const mongoose = require('mongoose');

const ScanSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    location: {
        latitude: { type: Number, required: true },
        longitude: { type: Number, required: true },
    },
    scannedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Scan', ScanSchema);
