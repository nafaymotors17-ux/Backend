/**
 * Construct CloudFront URL from S3 key
 * Uses CLOUD_FRONT_URL from environment variables
 */
const getCloudFrontUrl = (key) => {
  if (!key) return null;

  const cloudFrontUrl = process.env.CLOUD_FRONT_URL;

  if (cloudFrontUrl) {
    // Remove trailing slash if present
    const baseUrl = cloudFrontUrl.replace(/\/$/, "");
    // Remove leading slash from key if present
    const cleanKey = key.startsWith("/") ? key.slice(1) : key;
    const url = `${baseUrl}/${cleanKey}`;
    console.log(`✅ Using CloudFront URL: ${url}`);
    return url;
  }

  // Fallback to S3 URL if CloudFront not configured
  console.warn(
    `⚠️ CLOUD_FRONT_URL not set, falling back to S3 URL for key: ${key}`
  );
  const bucket = process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET || "";
  const region = process.env.AWS_REGION || "ap-northeast-1";
  if (bucket) {
    const cleanKey = key.startsWith("/") ? key.slice(1) : key;
    const s3Url = `https://${bucket}.s3.${region}.amazonaws.com/${cleanKey}`;
    console.log(`⚠️ Using S3 URL (fallback): ${s3Url}`);
    return s3Url;
  }

  console.error(
    `❌ No bucket configured, cannot construct URL for key: ${key}`
  );
  return null;
};

/**
 * Add CloudFront URL to image object
 * Returns image with both key and url (constructed from key)
 * If image already has a URL, it will be replaced with CloudFront URL
 */
const addImageUrl = (image) => {
  if (!image) return image;

  if (image.key) {
    const cloudFrontUrl = getCloudFrontUrl(image.key);
    return {
      ...image,
      url: cloudFrontUrl, // Always use CloudFront URL constructed from key
    };
  }

  // If no key but has URL, return as-is (backward compatibility)
  return image;
};

/**
 * Add CloudFront URLs to array of images
 */
const addImageUrls = (images) => {
  if (!Array.isArray(images)) return images;
  return images.map(addImageUrl);
};

module.exports = {
  getCloudFrontUrl,
  addImageUrl,
  addImageUrls,
};
