require('dotenv').config();
const express = require('express');
const mongoose = require('./db');
const productRoutes = require('./routes/productRoutes');

const app = express();
app.use(express.json());
app.use('/api', productRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running ${PORT}`));
