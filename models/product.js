const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    stationId: { type: String, required: true },
    uuid: {
        type: String,
        required: true,
        validate: {
            validator: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
            message: 'Invalid UUID format',
        },
    },
    signedQRCode: { type: String, required: true },
    batchId: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
});

productSchema.index({ batchId: 1 });
productSchema.index({ uuid: 1 }, { unique: true });

module.exports = mongoose.model('Product', productSchema);
