const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    });
  }
  return browserInstance;
}

// ─────────────────────────────────────────
// 1. 네이버 로그인 & 세션 쿠키 반환
// ─────────────────────────────────────────
async function naverLogin(naverId, naverPassword) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  try {
    console.log('🔐 네이버 로그인 시작...');

    await page.goto('https://nid.naver.com/nidlogin.login', {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    await page.screenshot({ path: '/tmp/before_login.png' });
    console.log('현재 페이지 타이틀:', await page.title());
    console.log('id 필드 존재:', await page.$('#id') !== null);

    await page.click('#id');
    await page.keyboard.type(naverId, { delay: 80 });
    await page.waitForTimeout(500);

    await page.click('#pw');
    await page.keyboard.type(naverPassword, { delay: 80 });
    await page.waitForTimeout(500);

    await page.click('#log\\.login');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: '/tmp/after_login.png' });

    const currentUrl = page.url();
    console.log('로그인 후 URL:', currentUrl);

    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 500));
    console.log('페이지 내용:', pageText);

    if (currentUrl.includes('captcha') || currentUrl.includes('challenge')) {
      await context.close();
      return {
        success: false,
        error: 'CAPTCHA',
        message: '캡차 또는 보안 인증이 필요합니다. 잠시 후 다시 시도해주세요.'
      };
    }

    if (currentUrl.includes('nidlogin') || currentUrl.includes('error')) {
      await context.close();
      return {
        success: false,
        error: 'LOGIN_FAILED',
        message: '아이디 또는 비밀번호가 올바르지 않습니다.'
      };
    }

    try {
      const skipBtn = await page.$('text=나중에 등록하기');
      if (skipBtn) await skipBtn.click();
    } catch (e) {}

    const cookies = await context.cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    await context.close();

    console.log('✅ 로그인 성공');
    return {
      success: true,
      sessionCookie: cookieString,
      cookies: cookies
    };

  } catch (error) {
    await context.close();
    console.error('로그인 오류:', error);
    return {
      success: false,
      error: 'UNKNOWN',
      message: error.message
    };
  }
}

// ─────────────────────────────────────────
// 2. 스마트플레이스 리뷰 목록 가져오기
// ─────────────────────────────────────────
async function fetchNaverReviews(sessionCookie, placeMid) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });

  const cookieArray = sessionCookie.split('; ').map(pair => {
    const [name, ...rest] = pair.split('=');
    return {
      name: name.trim(),
      value: rest.join('='),
      domain: '.naver.com',
      path: '/'
    };
  });

  await context.addCookies(cookieArray);
  const page = await context.newPage();

  try {
    console.log('📋 리뷰 목록 가져오기...');

    const reviewUrl = `https://smartplace.naver.com/places/${placeMid}/reviews`;
    await page.goto(reviewUrl, { waitUntil: 'networkidle', timeout: 30000 });

    if (page.url().includes('login')) {
      await context.close();
      return { success: false, error: 'SESSION_EXPIRED', message: '세션이 만료되었습니다. 다시 로그인해주세요.' };
    }

    await page.waitForTimeout(2000);

    const reviews = await page.evaluate(() => {
      const reviewItems = [];
      const cards = document.querySelectorAll('[class*="ReviewItem"], [class*="review_item"], .review_list_item');
      
      cards.forEach((card, index) => {
        try {
          const nameEl = card.querySelector('[class*="reviewer"], [class*="name"], .reviewer_name');
          const ratingEl = card.querySelector('[class*="rating"], [class*="star"], .star_score');
          const contentEl = card.querySelector('[class*="content"], [class*="text"], .review_content');
          const dateEl = card.querySelector('[class*="date"], .review_date');
          const idEl = card.closest('[data-review-id]') || card;

          reviewItems.push({
            reviewId: idEl.getAttribute('data-review-id') || `review_${index}`,
            reviewerName: nameEl?.textContent?.trim() || '익명',
            rating: parseInt(ratingEl?.textContent?.trim()) || 5,
            content: contentEl?.textContent?.trim() || '',
            reviewDate: dateEl?.textContent?.trim() || '',
            hasReply: !!card.querySelector('[class*="reply"], [class*="owner"]')
          });
        } catch (e) {}
      });

      return reviewItems;
    });

    await context.close();

    console.log(`✅ 리뷰 ${reviews.length}개 수집 완료`);
    return { success: true, reviews };

  } catch (error) {
    await context.close();
    console.error('리뷰 수집 오류:', error);
    return { success: false, error: 'FETCH_ERROR', message: error.message };
  }
}

// ─────────────────────────────────────────
// 3. 리뷰에 답글 등록
// ─────────────────────────────────────────
async function postNaverReply(sessionCookie, placeMid, reviewId, replyContent) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });

  const cookieArray = sessionCookie.split('; ').map(pair => {
    const [name, ...rest] = pair.split('=');
    return {
      name: name.trim(),
      value: rest.join('='),
      domain: '.naver.com',
      path: '/'
    };
  });

  await context.addCookies(cookieArray);
  const page = await context.newPage();

  try {
    console.log(`💬 답글 등록 시작 - 리뷰 ID: ${reviewId}`);

    const reviewUrl = `https://smartplace.naver.com/places/${placeMid}/reviews`;
    await page.goto(reviewUrl, { waitUntil: 'networkidle', timeout: 30000 });

    if (page.url().includes('login')) {
      await context.close();
      return { success: false, error: 'SESSION_EXPIRED', message: '세션이 만료되었습니다.' };
    }

    await page.waitForTimeout(2000);

    const reviewCard = await page.$(`[data-review-id="${reviewId}"]`);
    if (!reviewCard) {
      await context.close();
      return { success: false, error: 'REVIEW_NOT_FOUND', message: '리뷰를 찾을 수 없습니다.' };
    }

    const replyBtn = await reviewCard.$('[class*="reply_btn"], button[class*="reply"], .btn_reply');
    if (!replyBtn) {
      await context.close();
      return { success: false, error: 'REPLY_BTN_NOT_FOUND', message: '답글 버튼을 찾을 수 없습니다.' };
    }

    await replyBtn.click();
    await page.waitForTimeout(1000);

    const textarea = await page.$('textarea[class*="reply"], [class*="reply_input"] textarea');
    if (!textarea) {
      await context.close();
      return { success: false, error: 'TEXTAREA_NOT_FOUND', message: '답글 입력창을 찾을 수 없습니다.' };
    }

    await textarea.click();
    await textarea.fill(replyContent);
    await page.waitForTimeout(500);

    const submitBtn = await page.$('button[class*="submit"], button[class*="register"], .btn_submit');
    if (submitBtn) {
      await submitBtn.click();
      await page.waitForTimeout(2000);
    }

    await context.close();

    console.log('✅ 답글 등록 완료');
    return { success: true, message: '답글이 성공적으로 등록되었습니다.' };

  } catch (error) {
    await context.close();
    console.error('답글 등록 오류:', error);
    return { success: false, error: 'POST_ERROR', message: error.message };
  }
}

// ─────────────────────────────────────────
// 4. 네이버 블로그 글 작성 & 발행 (테스트: 접근 확인용)
// ─────────────────────────────────────────
async function postNaverBlog(naverId, naverPassword, title, content) {
  const loginResult = await naverLogin(naverId, naverPassword);

  if (!loginResult.success) {
    return loginResult;
  }

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });

  const cookieArray = loginResult.sessionCookie.split('; ').map(pair => {
    const [name, ...rest] = pair.split('=');
    return {
      name: name.trim(),
      value: rest.join('='),
      domain: '.naver.com',
      path: '/'
    };
  });

  await context.addCookies(cookieArray);
  const page = await context.newPage();

  try {
    console.log('📝 네이버 블로그 글쓰기 페이지 이동...');

    await page.goto('https://blog.naver.com/GoBlogWrite.naver', {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    await page.waitForTimeout(3000);
    console.log('블로그 페이지 URL:', page.url());
    console.log('블로그 페이지 타이틀:', await page.title());

    await page.screenshot({ path: '/tmp/blog_write.png' });

    const blogPageText = await page.evaluate(() => document.body.innerText.slice(0, 300));
    console.log('블로그 페이지 내용:', blogPageText);

    const resultUrl = page.url();
    await context.close();

    return {
      success: true,
      message: '블로그 글쓰기 페이지 접근 테스트 완료',
      currentUrl: resultUrl
    };

  } catch (error) {
    await context.close();
    console.error('블로그 작성 오류:', error);
    return { success: false, error: 'BLOG_POST_ERROR', message: error.message };
  }
}

module.exports = { naverLogin, fetchNaverReviews, postNaverReply, postNaverBlog };
