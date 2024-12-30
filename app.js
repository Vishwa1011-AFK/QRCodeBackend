require('dotenv').config();
const express = require('express');
const mongoose = require('./db');
const productRoutes = require('./routes/productRoutes');

const app = express();

// Middleware for parsing JSON bodies
app.use(express.json());

// Route handling
app.use('/api', productRoutes);

// Global error handling middleware (optional)
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    if (!process.env.PORT) {
        console.log("Warning: PORT environment variable not set. Using default port 3000.");
    }
    console.log(`Server running on port ${PORT}`);
});
