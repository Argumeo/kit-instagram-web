const { chromium } = require('playwright');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const HANDLE = 'sonica.peru';
const ASSETS_DIR = path.join(__dirname, 'assets', 'instagram');

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function scrapeInstagram() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'es-ES',
    viewport: { width: 1280, height: 900 }
  });

  const page = await context.newPage();
  const result = { handle: HANDLE, photos: [] };

  try {
    console.log(`Navegando a https://www.instagram.com/${HANDLE}/`);
    await page.goto(`https://www.instagram.com/${HANDLE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Extract meta tags
    const ogTitle = await page.$eval('meta[property="og:title"]', el => el.content).catch(() => '');
    const ogDesc = await page.$eval('meta[property="og:description"]', el => el.content).catch(() => '');
    const ogImage = await page.$eval('meta[property="og:image"]', el => el.content).catch(() => '');

    console.log('og:title:', ogTitle);
    console.log('og:description:', ogDesc);
    console.log('og:image:', ogImage);

    // Parse name from title
    result.name = ogTitle.replace(' • Instagram photos and videos', '').replace(' • Fotos y videos de Instagram', '').trim();

    // Parse stats from description: "X Followers, Y Following, Z Posts - bio"
    const statsMatch = ogDesc.match(/([\d,.KMk]+)\s*(?:Followers|Seguidores),\s*([\d,.KMk]+)\s*(?:Following|Seguidos),\s*([\d,.KMk]+)\s*(?:Posts?|Publicaciones?)/i);
    if (statsMatch) {
      result.followers = statsMatch[1];
      result.following = statsMatch[2];
      result.posts = statsMatch[3];
      result.bio = ogDesc.split(' - ').slice(1).join(' - ').trim();
    } else {
      result.bio = ogDesc;
    }

    result.profileImageUrl = ogImage;

    // Try to get more data from page
    const pageTitle = await page.title();
    console.log('Page title:', pageTitle);

    // Check if logged-in wall
    const loginWall = await page.$('input[name="username"]').catch(() => null);
    if (loginWall) {
      console.log('Login wall detected');
      result.loginWall = true;
    }

    // Try to extract profile data from JSON embedded in page
    const pageContent = await page.content();

    // Look for JSON data
    const jsonMatch = pageContent.match(/"biography":"([^"]*?)"/);
    if (jsonMatch) result.biography = jsonMatch[1];

    const categoryMatch = pageContent.match(/"category_name":"([^"]*?)"/);
    if (categoryMatch) result.category = categoryMatch[1];

    const fullNameMatch = pageContent.match(/"full_name":"([^"]*?)"/);
    if (fullNameMatch && fullNameMatch[1]) result.fullName = fullNameMatch[1];

    const websiteMatch = pageContent.match(/"website":"([^"]*?)"/);
    if (websiteMatch) result.website = websiteMatch[1];

    const verifiedMatch = pageContent.match(/"is_verified":(true|false)/);
    if (verifiedMatch) result.verified = verifiedMatch[1] === 'true';

    // Try to extract post images
    const imgUrls = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs
        .map(img => ({ src: img.src, alt: img.alt, width: img.naturalWidth || img.width }))
        .filter(img => img.src && img.src.includes('cdninstagram') && img.width > 100)
        .slice(0, 20);
    });

    console.log(`Found ${imgUrls.length} potential post images`);
    result.postImages = imgUrls;

    // Scroll to load more images
    await page.evaluate(() => window.scrollBy(0, 600));
    await page.waitForTimeout(2000);

    const moreImgs = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs
        .map(img => ({ src: img.src, alt: img.alt, width: img.naturalWidth || img.width }))
        .filter(img => img.src && img.src.includes('cdninstagram') && img.width > 100);
    });

    const allImgs = [...new Set([...imgUrls.map(i => i.src), ...moreImgs.map(i => i.src)])];
    result.postImages = allImgs;
    console.log(`Total unique images: ${allImgs.length}`);

  } catch (err) {
    console.error('Error during scraping:', err.message);
    result.error = err.message;
  }

  await browser.close();

  // Download profile photo
  if (result.profileImageUrl) {
    console.log('Downloading profile photo...');
    try {
      await downloadFile(result.profileImageUrl, path.join(ASSETS_DIR, 'profile.jpg'));
      result.profilePhoto = 'assets/instagram/profile.jpg';
      console.log('Profile photo downloaded');
    } catch (err) {
      console.error('Could not download profile photo:', err.message);
    }
  }

  // Download post images
  let postCount = 0;
  if (result.postImages && result.postImages.length > 0) {
    const postUrls = typeof result.postImages[0] === 'string' ? result.postImages : result.postImages.map(i => i.src);
    // Filter out profile/avatar images (usually smaller)
    const filteredUrls = postUrls.filter(url => url && !url.includes('profile_pic') && !url.includes('44x44') && !url.includes('150x150'));

    for (let i = 0; i < Math.min(filteredUrls.length, 9); i++) {
      const url = filteredUrls[i];
      if (!url) continue;
      const dest = path.join(ASSETS_DIR, `post-${i + 1}.jpg`);
      try {
        await downloadFile(url, dest);
        result.photos.push(`assets/instagram/post-${i + 1}.jpg`);
        postCount++;
        console.log(`Downloaded post-${i + 1}.jpg`);
      } catch (err) {
        console.log(`Could not download image ${i + 1}: ${err.message}`);
      }
    }
  }

  result.totalPhotosDownloaded = postCount;
  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(result, null, 2));

  fs.writeFileSync(path.join(__dirname, 'instagram-data.json'), JSON.stringify(result, null, 2));
  console.log('\nData saved to instagram-data.json');
}

scrapeInstagram().catch(console.error);
