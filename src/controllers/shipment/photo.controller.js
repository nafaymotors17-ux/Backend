const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
// const archiver = require("archiver"); // No longer needed - ZIP creation moved to frontend
const mongoose = require("mongoose");

const Shipment = require("../../models/shipment.model");
const { addImageUrls } = require("../../utils/cloudfront");

const { s3, BUCKET } = require("../../aws/s3Config");
/**
 * Step 1 — Generate signed URLs for upload
 * Each upload replaces any existing photo (same name)
 */
// ZIP upload functionality removed - no longer needed

exports.generateSignedUrls = async (req, res) => {
  try {
    const { shipmentId, fileNames } = req.body;

    if (!shipmentId || !Array.isArray(fileNames) || fileNames.length === 0) {
      return res
        .status(400)
        .json({ message: "shipmentId and fileNames[] are required" });
    }

    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(shipmentId)) {
      return res.status(400).json({ message: "Invalid shipment ID format" });
    }

    const shipment = await Shipment.findById(shipmentId);
    if (!shipment) {
      return res.status(404).json({ message: "Shipment not found" });
    }

    // ✅ FIXED: Use shipment._id.toString() to ensure consistent folder name
    // Each shipment has ONE unique folder: cars/{shipmentId}/
    // This ensures no duplicate folders - same shipment = same folder always
    const shipmentFolderId = shipment._id.toString();
    const signedUrls = [];

    for (const fileName of fileNames) {
      // Clean up file name - remove special chars, keep only alphanumeric, dots, hyphens, underscores
      // Normalize to lowercase to prevent case-sensitive duplicates
      const safeName = fileName
        .replace(/[^a-zA-Z0-9._-]/g, "_") // Replace special chars with underscore
        .replace(/\s+/g, "_") // Replace spaces with underscore
        .toLowerCase(); // Normalize to lowercase for consistency

      // ✅ FIXED: Consistent folder structure - cars/{shipmentId}/{fileName}
      // Same shipment ID + same file name = same S3 key = REPLACES existing file
      // S3 PutObjectCommand automatically replaces files with the same key (no duplicates)
      const key = `cars/${shipmentFolderId}/${safeName}`;

      // Log for debugging
      // console.log(
      //   `📤 Generating upload URL for: ${key} (shipment: ${shipmentFolderId})`
      // );

      // ✅ IMPORTANT: PutObjectCommand with same key REPLACES existing file
      // This ensures no duplicates - same file name = same S3 key = replacement
      // Set Cache-Control for CloudFront caching (photos never change, cache for 1 year)
      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          ContentType: "image/jpeg", // or detect dynamically
          CacheControl: "max-age=31536000, public", // 1 year cache (31536000 seconds)
        }),
        { expiresIn: 300 } // 5 minutes
      );

      // Return both key and publicUrl for backward compatibility
      // Frontend can use publicUrl for immediate display, backend constructs CloudFront URL
      signedUrls.push({
        fileName: safeName,
        key,
        uploadUrl,
        publicUrl: `https://${BUCKET}.s3.${
          process.env.AWS_REGION || "ap-northeast-1"
        }.amazonaws.com/${key}`,
      });
    }

    // console.log(
    //   `✅ Generated ${signedUrls.length} signed URLs for shipment ${shipmentFolderId}`
    // );
    res.status(200).json({ signedUrls });
  } catch (err) {
    console.error("Error generating signed URLs:", err);
    console.error("Error stack:", err.stack);
    res.status(500).json({
      message: "Failed to generate signed URLs",
      error: err.message,
    });
  }
};

/**
 * Step 2 — Confirm photo upload and update DB
 */
exports.confirmPhotoUpload = async (req, res) => {
  try {
    const { shipmentId, photos } = req.body;

    // Validate shipmentId
    if (!shipmentId || !mongoose.Types.ObjectId.isValid(shipmentId)) {
      return res.status(400).json({ message: "Invalid shipment ID format" });
    }

    const shipment = await Shipment.findById(shipmentId);
    if (!shipment) {
      return res.status(404).json({ message: "Shipment not found" });
    }

    // ✅ Ensure we're using the correct shipment folder ID
    const shipmentFolderId = shipment._id.toString();

    // ✅ Validate that all photo keys belong to this shipment's folder
    const invalidPhotos = photos.filter(
      (p) => !p.key || !p.key.startsWith(`cars/${shipmentFolderId}/`)
    );

    if (invalidPhotos.length > 0) {
      console.error("❌ Invalid photo keys detected:", invalidPhotos);
      return res.status(400).json({
        message: "Some photo keys do not belong to this shipment's folder",
      });
    }

    // ✅ FIXED: Create a map of new photos by key for quick lookup
    // Same key = replace existing photo (no duplicates in DB)
    const newPhotosMap = new Map(photos.map((p) => [p.key, p]));

    // ✅ FIXED: Keep existing photos that are NOT being replaced
    // If a photo with the same key is uploaded, it replaces the existing one
    const existingImages = shipment?.carId.images || [];
    const photosNotBeingReplaced = existingImages.filter(
      (img) => !newPhotosMap.has(img.key) // Keep photos that aren't being replaced
    );

    // Count how many are being replaced vs added new
    const photosBeingReplaced = existingImages.filter((img) =>
      newPhotosMap.has(img.key)
    );
    const trulyNewPhotos = photos.length - photosBeingReplaced.length; // Only count photos with new keys
    const totalAfterUpload = photosNotBeingReplaced.length + photos.length; // Existing (not replaced) + all uploaded photos

    // console.log(
    //   `Photo limit check: ${existingImages.length} existing (${photosBeingReplaced.length} being replaced, ${photosNotBeingReplaced.length} kept) + ${trulyNewPhotos} new = ${totalAfterUpload} total`
    // );

    // ✅ CRITICAL: Check 25-photo limit on the SERVER (after accounting for replacements)
    if (totalAfterUpload > 25) {
      return res.status(400).json({
        message: `Cannot upload ${photos.length} photos. Car already has ${existingImages.length} photos. Maximum 25 allowed.`,
      });
    }

    // ✅ FIXED: Add/Replace photos - same key = replace, new key = add
    // This ensures no duplicates - if same file name uploaded again, it replaces
    const updatedImages = [...photosNotBeingReplaced];

    photos.forEach((p) => {
      // Check if this key already exists in the kept photos (shouldn't happen, but double-check)
      const existingIndex = updatedImages.findIndex((img) => img.key === p.key);

      if (existingIndex >= 0) {
        // Replace existing photo with same key (shouldn't happen after filter, but handle it)
        updatedImages[existingIndex] = {
          _id: updatedImages[existingIndex]._id, // Keep existing _id if any
          key: p.key,
          url: p.publicUrl, // Store URL for backward compatibility
          name: p.fileName,
          alt: updatedImages[existingIndex].alt || "Car photo",
        };
      } else {
        // Add new photo
        updatedImages.push({
          key: p.key,
          url: p.publicUrl, // Store URL for backward compatibility
          name: p.fileName,
          alt: "Car photo",
        });
      }
    });

    // console.log(
    //   `✅ Confirmed upload for shipment ${shipmentFolderId}: ${photos.length} photos processed, total: ${updatedImages.length}`
    // );

    // ✅ DOUBLE CHECK: Ensure we don't exceed 25 photos
    if (updatedImages.length > 25) {
      return res.status(400).json({
        message: `Photo limit exceeded. Would have ${updatedImages.length} photos after upload. Maximum 25 allowed.`,
      });
    }

    shipment.carId.images = updatedImages;
    await shipment.save();

    // Add CloudFront URLs to images before sending response (for display)
    // But also keep stored URLs for backward compatibility
    const photosWithUrls = addImageUrls(shipment.carId.images);

    res.json({
      message: "Car photos updated successfully",
      shipment,
      photos: shipment.carId.images, // Return photos with stored URLs (backward compatible)
      totalCount: shipment.carId.images.length,
    });
  } catch (err) {
    console.error("Error confirming upload:", err);
    console.error("Error stack:", err.stack);
    res.status(500).json({
      message: "Failed to confirm upload",
      error: err.message,
    });
  }
};

/**
 * Confirm ZIP file upload and update DB
 * ZIP file is stored in same folder as photos: cars/{shipmentId}/{chassis}.zip
 */
exports.confirmZipUpload = async (req, res) => {
  try {
    const { shipmentId, zipFileKey, zipFileSize } = req.body;

    if (!shipmentId || !mongoose.Types.ObjectId.isValid(shipmentId)) {
      return res.status(400).json({ message: "Invalid shipment ID format" });
    }

    if (!zipFileKey) {
      return res.status(400).json({ message: "ZIP file key is required" });
    }

    // Validate ZIP file size (max 2MB)
    if (zipFileSize && zipFileSize > 2 * 1024 * 1024) {
      return res
        .status(400)
        .json({ message: "ZIP file size exceeds 2MB limit" });
    }

    const shipment = await Shipment.findById(shipmentId);
    if (!shipment) {
      return res.status(404).json({ message: "Shipment not found" });
    }

    // Update ZIP file info - only store key, URL will be constructed from key
    if (!shipment.carId) {
      shipment.carId = { images: [] };
    }

    shipment.carId.zipFileKey = zipFileKey;
    shipment.carId.zipFileSize = zipFileSize || 0;
    // zipFileUrl removed - will be constructed from key using CloudFront

    await shipment.save();

    res.json({
      message: "ZIP file uploaded successfully",
      shipment: {
        _id: shipment._id,
        carId: {
          zipFileKey: shipment.carId.zipFileKey,
          zipFileSize: shipment.carId.zipFileSize,
        },
      },
    });
  } catch (err) {
    console.error("Error confirming ZIP upload:", err);
    console.error("Error stack:", err.stack);
    res.status(500).json({
      message: "Failed to confirm ZIP upload",
      error: err.message,
    });
  }
};

// controllers/shipment.controller.js
exports.deleteCarPhotos = async (req, res) => {
  try {
    const { shipmentId, photos } = req.body; // photos = [_id1, _id2, ...]

    if (!shipmentId || !Array.isArray(photos) || photos.length === 0) {
      return res
        .status(400)
        .json({ message: "Car ID and photos are required" });
    }

    const shipment = await Shipment.findById(shipmentId);
    if (!shipment) return res.status(404).json({ message: "Car not found" });

    // Get only the images that match the provided _ids
    const imagesToDelete = shipment.carId.images.filter((img) =>
      photos.includes(img._id?.toString())
    );

    if (imagesToDelete.length === 0) {
      return res.status(400).json({ message: "No valid photos to delete" });
    }

    // Get S3 keys
    const keysToDelete = imagesToDelete
      .map((img) => img.key)
      .filter((key) => key && key.trim() !== "");

    // console.log("Keys to delete from S3:", keysToDelete);

    // Delete images from S3
    if (keysToDelete.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: {
            Objects: keysToDelete.map((Key) => ({ Key })),
            Quiet: true,
          },
        })
      );
    }

    // Remove deleted images from DB
    shipment.carId.images = shipment.carId.images.filter(
      (img) => !photos.includes(img._id?.toString())
    );

    // ZIP file deletion removed - no longer storing ZIP files

    await shipment.save();

    res.json({
      message: "Selected photos deleted successfully",
      photos: shipment.carId.images, // Return updated photos array
    });
  } catch (err) {
    console.error("Error deleting shipment photos:", err);
    console.error("Error stack:", err.stack);
    res.status(500).json({
      message: "Failed to delete photos",
      success: false,
      error: err.message,
    });
  }
};

// Download photos - returns S3 signed URLs for frontend to download and create ZIP
// ✅ Using S3 signed URLs for downloads (temporary access, secure)
// ✅ CloudFront URLs are used for viewing (cached for 1 year, reduces S3 costs)
exports.downloadCarPhotos = async (req, res) => {
  try {
    const { shipmentId } = req.query;
    const userId = req.user?._id; // Get user from JWT middleware

    if (!shipmentId || !mongoose.Types.ObjectId.isValid(shipmentId)) {
      return res.status(400).json({ message: "Invalid shipment ID" });
    }

    const shipment = await Shipment.findById(shipmentId);
    if (!shipment)
      return res.status(404).json({ message: "Shipment not found" });

    // ✅ SECURITY: Verify user has access to this shipment
    // Admin can access any shipment, customer can only access their own
    if (
      req.user.role !== "admin" &&
      shipment.clientId?.toString() !== userId?.toString()
    ) {
      return res.status(403).json({
        message:
          "Access denied. You don't have permission to download photos for this shipment.",
      });
    }

    // Check if shipment has photos
    if (!shipment.carId?.images || shipment.carId.images.length === 0) {
      return res.status(404).json({ message: "No photos found" });
    }

    const signedUrls = [];

    // Generate S3 signed URLs for each photo (temporary access for downloads)
    for (const image of shipment.carId.images) {
      if (!image.key) continue;

      try {
        // Generate signed URL for download (valid for 1 hour)
        const downloadUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: BUCKET,
            Key: image.key,
          }),
          { expiresIn: 3600 } // 1 hour
        );

        const fileName = image.key.split("/").pop();
        signedUrls.push({
          url: downloadUrl, // S3 signed URL (temporary, secure)
          fileName: fileName,
          key: image.key,
        });
      } catch (err) {
        console.error(`Error generating signed URL for ${image.key}:`, err);
        // Continue with other photos even if one fails
      }
    }

    if (signedUrls.length === 0) {
      return res
        .status(404)
        .json({ message: "No photos available for download" });
    }

    // Return S3 signed URLs - frontend will download and create ZIP
    res.setHeader("Content-Type", "application/json");
    res.json({
      photos: signedUrls,
      shipmentId: shipment._id.toString(),
      chassisNumber: shipment.carId?.chassisNumber || shipment._id.toString(),
    });
  } catch (err) {
    console.error("Download error:", err);
    if (!res.headersSent) res.status(500).json({ message: "Server error" });
  }
};
