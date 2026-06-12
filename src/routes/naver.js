const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const CryptoJS = require('crypto-js');
const { naverLogin, fetchNaverReviews, postNaverReply, postNaverBlog } = require('../services/naverAutomation');

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

// ─────────────────────────────────────────
// POST /api/naver/verify
// ─────────────────────────────────────────
router.post('/verify', verifyUser, async (req, res) => {
  console.log('verify 요청 받음:', req.body);
  const { naverId, naverPassword, placeMid, placeName } = req.body;

  if (!naverId || !naverPassword) {
    return res.status(400).json({ success: false, error: '아이디와 비밀번호를 입력해주세요.' });
  }

  try {
    const result = await naverLogin(naverId, naverPassword);
    console.log('로그인 결과:', result.success, result.error || '');

    if (!result.success) {
      return res.json(result);
    }

    const encryptedPassword = encrypt(naverPassword);
    const encryptedCookie = encrypt(result.sessionCookie);

    await supabase.from('naver_accounts').delete().eq('user_id', req.userId);

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
});

// ─────────────────────────────────────────
// GET /api/naver/reviews
// ─────────────────────────────────────────
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

    const sessionCookie = decrypt(account.session_cookie);
    let result = await fetchNaverReviews(sessionCookie, account.place_mid);
    console.log('리뷰 조회 결과:', result.success, result.error || '', result.reviews?.length || 0);

    if (!result.success && result.error === 'SESSION_EXPIRED') {
      const naverPassword = decrypt(account.encrypted_password);
      const loginResult = await naverLogin(account.naver_id, naverPassword);

      if (loginResult.success) {
        await supabase
          .from('naver_accounts')
          .update({ session_cookie: encrypt(loginResult.sessionCookie), status: 'connected' })
          .eq('user_id', req.userId);

        result = await fetchNaverReviews(loginResult.sessionCookie, account.place_mid);
      } else {
        await supabase.from('naver_accounts').update({ status: 'expired' }).eq('user_id', req.userId);
        return res.json({ success: false, error: 'SESSION_EXPIRED', message: '세션이 만료되었습니다. 다시 연동해주세요.' });
      }
    }

    if (!result.success) {
      return res.json(result);
    }

    await saveReviewsToDb(req.userId, account.id, result.reviews);
    res.json(result);

  } catch (error) {
    console.error('reviews 오류:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────
// POST /api/naver/reply
// ─────────────────────────────────────────
router.post('/reply', verifyUser, async (req, res) => {
  const { reviewId, replyContent, supabaseReviewId } = req.body;

  if (!reviewId || !replyContent) {
    return res.status(400).json({ success: false, error: '리뷰 ID와 답글 내용이 필요합니다.' });
  }

  try {
    const { data: account } = await supabase
      .from('naver_accounts')
      .select('*')
      .eq('user_id', req.userId)
      .single();

    if (!account) {
      return res.json({ success: false, error: '연동된 네이버 계정이 없습니다.' });
    }

    const sessionCookie = decrypt(account.session_cookie);
    const result = await postNaverReply(sessionCookie, account.place_mid, reviewId, replyContent);

    if (result.success && supabaseReviewId) {
      await supabase
        .from('naver_reviews')
        .update({ reply_content: replyContent, reply_status: 'published' })
        .eq('id', supabaseReviewId);
    }

    res.json(result);

  } catch (error) {
    console.error('reply 오류:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────
// POST /api/naver/blog
// 네이버 블로그 글 작성 테스트
// ─────────────────────────────────────────
router.post('/blog', verifyUser, async (req, res) => {
  const { naverId, naverPassword, title, content } = req.body;

  if (!naverId || !naverPassword || !title || !content) {
    return res.status(400).json({ success: false, error: '필수 정보가 누락되었습니다.' });
  }

  try {
    const result = await postNaverBlog(naverId, naverPassword, title, content);
    res.json(result);
  } catch (error) {
    console.error('blog 오류:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────
async function saveReviewsToDb(userId, accountId, reviews) {
  for (const review of reviews) {
    const { data: existing } = await supabase
      .from('naver_reviews')
      .select('id')
      .eq('user_id', userId)
      .eq('review_source_id', review.reviewId)
      .single();

    if (!existing) {
      await supabase.from('naver_reviews').insert({
        user_id: userId,
        naver_account_id: accountId,
        reviewer_name: review.reviewerName,
        rating: review.rating,
        content: review.content,
        review_date: review.reviewDate,
        review_source_id: review.reviewId,
        reply_status: review.hasReply ? 'published' : 'pending'
      });
    }
  }
}

module.exports = router;
