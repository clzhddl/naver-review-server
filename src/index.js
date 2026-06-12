require('dotenv').config();
const express = require('express');
const cors = require('cors');
const naverRoutes = require('./routes/naver');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: '식당코치 AI 네이버 자동화 서버 🚀' });
});

app.use('/api/naver', naverRoutes);

app.use((err, req, res, next) => {
  console.error('서버 오류:', err);
  res.status(500).json({ success: false, error: err.message });
});

app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중: http://localhost:${PORT}`);
});
