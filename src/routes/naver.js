const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const CryptoJS = require('crypto-js');
const { naverLogin, fetchNaverReviews, postNaverReply } = require('../services/naverAutomation');

// Supabase 클라이언트
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// 암호화/복호화
const ENCRYPT_KEY = process.env.ENCRYPT_SECRET || 'placecoachai-secret-key-2024';

function encrypt(text) {
  return CryptoJS.AES.encrypt(text, ENCRYPT_KEY).toString();
}

function decrypt(cipherText) {
  const bytes = CryptoJS.AES.decrypt(cipherText, ENCRYPT_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

// JWT 검증 미들웨어
async function verifyUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ success: false, error: '인증 토큰이 없습니다.' });
  }

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ success: false, error: '유효하지 않은 토큰입니다.' });
  }

  req.userId = user.id;
  next();
}

// ─────────────────────────────────────────
// POST /api/naver/verify
// 네이버 로그인 & 세션 저장
// ─────────────────────────────────────────
router.post('/verify', verifyUser, async (req, res) => {
  const { naverId, naverPassword, placeMid, placeName } = req.body;

  if (!naverId || !naverPassword) {
    return res.status(400).json({ success: false, error: '아이디와 비밀번호를 입력해주세요.' });
  }

  try {
    const result = await naverLogin(naverId, naverPassword);

    if (!result.success) {
      return res.json(result);
    }

    // 세션 쿠키 & 비밀번호 암호화 저장
    const encryptedPassword = encrypt(naverPassword);
    const encryptedCookie = encrypt(result.sessionCookie);

    const { error: dbError } = await supabase
      .from('naver_accounts')
      .upsert({
        user_id: req.userId,
        naver_id: naverId,
        encrypted_password: encryptedPassword,
        place_mid: placeMid,
        place_name: placeName,
        session_cookie: encryptedCookie,
        status: 'connected',
        connected_at: new Date().toISOString()
      }, {
        onConflict: 'user_id'
      });

    if (dbError) {
      console.error('DB 저장 오류:', dbError);
      return res.json({ success: false, error: 'DB 저장 실패', message: dbError.message });
    }

    res.json({ success: true, message: '네이버 계정이 성공적으로 연동되었습니다.' });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────
// GET /api/naver/reviews
// 리뷰 목록 가져오기
// ─────────────────────────────────────────
router.get('/reviews', verifyUser, async (req, res) => {
  try {
    // Supabase에서 세션 쿠키 가져오기
    const { data: account, error: accountError } = await supabase
      .from('naver_accounts')
      .select('*')
      .eq('user_id', req.userId)
      .single();

    if (accountError || !account) {
      return res.json({ success: false, error: 'ACCOUNT_NOT_FOUND', message: '연동된 네이버 계정이 없습니다.' });
    }

    const sessionCookie = decrypt(account.session_cookie);
    const result = await fetchNaverReviews(sessionCookie, account.place_mid);

    if (!result.success) {
      // 세션 만료 시 재로그인 시도
      if (result.error === 'SESSION_EXPIRED') {
        const naverPassword = decrypt(account.encrypted_password);
        const loginResult = await naverLogin(account.naver_id, naverPassword);

        if (loginResult.success) {
          // 새 세션 저장
          await supabase
            .from('naver_accounts')
            .update({
              session_cookie: encrypt(loginResult.sessionCookie),
              status: 'connected'
            })
            .eq('user_id', req.userId);

          // 재시도
          const retryResult = await fetchNaverReviews(loginResult.sessionCookie, account.place_mid);
          if (retryResult.success) {
            await saveReviewsToDb(req.userId, account.id, retryResult.reviews);
            return res.json(retryResult);
          }
        }

        // 재로그인도 실패
        await supabase
          .from('naver_accounts')
          .update({ status: 'expired' })
          .eq('user_id', req.userId);

        return res.json({ success: false, error: 'SESSION_EXPIRED', message: '세션이 만료되었습니다. 다시 연동해주세요.' });
      }

      return res.json(result);
    }

    // 리뷰 DB 저장
    await saveReviewsToDb(req.userId, account.id, result.reviews);

    res.json(result);

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────
// POST /api/naver/reply
// 답글 등록
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
      // DB 상태 업데이트
      await supabase
        .from('naver_reviews')
        .update({
          reply_content: replyContent,
          reply_status: 'published'
        })
        .eq('id', supabaseReviewId);
    }

    res.json(result);

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────
// 헬퍼: 리뷰 DB 저장 (중복 제외)
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
