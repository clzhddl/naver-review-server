const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const CryptoJS = require('crypto-js');
const { naverLogin, fetchNaverReviews, postNaverReply } = require('../services/naverAutomation');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ENCRYPT_KEY = process.env.ENCRYPT_SECRET || 'placecoachai-secret-key-2024';

function encrypt(text) {
  return CryptoJS.AES.encrypt(text, ENCRYPT_KEY).toString();
}

function decrypt(cipherText) {
  const bytes = CryptoJS.AES.decrypt(cipherText, ENCRYPT_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

async function verifyUser(req, res, next) {
  req.userId = 'test-user';
  next();
}

// POST /api/naver/verify
router.post('/verify', verifyUser, async (req, res) => {
  console.log('verify 요청 받음:', req.body);
  const { naverId, naverPassword, placeMid, placeName } = req.body;

  if (!naverId || !naverPassword) {
    return res.status(400).json({ success: false, error: '아이디와 비밀번호를 입력해주세요.' });
  }

try {
  const result = { success: true, sessionCookie: 'test-cookie-123' };

  const encryptedPassword = encrypt(naverPassword);
  const encryptedCookie = encrypt(result.sessionCookie);

  // 기존 데이터 삭제 후 새로 insert
  await supabase
    .from('naver_accounts')
    .delete()
    .eq('user_id', req.userId);

  const { error: dbError } = await supabase
    .from('naver_accounts')
    .insert({
      user_id: req.userId,
      naver_id: naverId,
      encrypted_password: encryptedPassword,
      place_mid: placeMid,
      place_name: placeName,
      session_cookie: encryptedCookie,
      status: 'connected',
      connected_at: new Date().toISOString()
    });

  if (dbError) {
    console.error('DB 저장 오류:', dbError);
    return res.json({ success: false, error: 'DB 저장 실패', message: dbError.message });
  }

  res.json({ success: true, message: '네이버 계정이 성공적으로 연동되었습니다.' });

} catch (error) {
  console.error('verify 오류:', error);
  res.status(500).json({ success: false, error: error.message });
}

// GET /api/naver/reviews
router.get('/reviews', verifyUser, async (req, res) => {
  try {
    const { data: account, error: accountError } = await supabase
      .from('naver_accounts')
      .select('*')
      .eq('user_id', req.userId)
      .single();

    if (accountError || !account) {
      return res.json({ success: false, error: 'ACCOUNT_NOT_FOUND', message: '연동된 네이버 계정이 없습니다.' });
    }

    // 임시 mock 리뷰 데이터
    const mockReviews = [
      {
        reviewId: 'review_1',
        reviewerName: '테스트고객',
        rating: 5,
        content: '음식이 정말 맛있었어요!',
        reviewDate: '2024-01-15',
        hasReply: false
      },
      {
        reviewId: 'review_2',
        reviewerName: '방문자',
        rating: 4,
        content: '서비스가 친절했습니다.',
        reviewDate: '2024-01-14',
        hasReply: false
      }
    ];

    res.json({ success: true, reviews: mockReviews });

  } catch (error) {
    console.error('reviews 오류:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/naver/reply
router.post('/reply', verifyUser, async (req, res) => {
  const { reviewId, replyContent, supabaseReviewId } = req.body;

  if (!reviewId || !replyContent) {
    return res.status(400).json({ success: false, error: '리뷰 ID와 답글 내용이 필요합니다.' });
  }

  try {
    if (supabaseReviewId) {
      await supabase
        .from('naver_reviews')
        .update({
          reply_content: replyContent,
          reply_status: 'published'
        })
        .eq('id', supabaseReviewId);
    }

    res.json({ success: true, message: '답글이 성공적으로 등록되었습니다.' });

  } catch (error) {
    console.error('reply 오류:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
