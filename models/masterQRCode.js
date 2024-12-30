const mongoose = require('mongoose');

const MasterQRCodeSchema = new mongoose.Schema({
    batchId: { type: String, required: true, unique: true },
    masterQRCode: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    scanRecords: [
        {
            scannedAt: { type: Date, default: Date.now },
            location: {
                latitude: { type: Number, required: true },
                longitude: { type: Number, required: true },
            },
        },
    ],
});

module.exports = mongoose.model('MasterQRCode', MasterQRCodeSchema);
