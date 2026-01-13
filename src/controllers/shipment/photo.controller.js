const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const archiver = require("archiver");
const mongoose = require("mongoose");

const Shipment = require("../../models/shipment.model");

const { s3, BUCKET } = require("../../aws/s3Config");
/**
 * Step 1 — Generate signed URLs for upload
 * Each upload replaces any existing photo (same name)
 */
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
      console.log(
        `📤 Generating upload URL for: ${key} (shipment: ${shipmentFolderId})`
      );

      // ✅ IMPORTANT: PutObjectCommand with same key REPLACES existing file
      // This ensures no duplicates - same file name = same S3 key = replacement
      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          ContentType: "image/jpeg", // or detect dynamically
        }),
        { expiresIn: 300 } // 5 minutes
      );

      signedUrls.push({
        fileName: safeName,
        key,
        uploadUrl,
        publicUrl: `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`,
      });
    }

    console.log(
      `✅ Generated ${signedUrls.length} signed URLs for shipment ${shipmentFolderId}`
    );
    res.status(200).json({ signedUrls });
  } catch (err) {
    console.error("Error generating signed URLs:", err);
    res.status(500).json({ message: "Failed to generate signed URLs" });
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

    // ✅ CRITICAL: Check 25-photo limit on the SERVER
    const existingPhotosCount = shipment?.carId.images
      ? shipment?.carId.images.length
      : 0;
    const newPhotosCount = photos.length;
    const totalAfterUpload = existingPhotosCount + newPhotosCount;

    console.log(
      `Photo limit check: ${existingPhotosCount} existing + ${newPhotosCount} new = ${totalAfterUpload} total`
    );

    if (totalAfterUpload > 25) {
      return res.status(400).json({
        message: `Cannot upload ${newPhotosCount} photos. Car already has ${existingPhotosCount} photos. Maximum 25 allowed.`,
      });
    }

    // ✅ FIXED: Create a map of new photos by key for quick lookup
    // Same key = replace existing photo (no duplicates in DB)
    const newPhotosMap = new Map(photos.map((p) => [p.key, p]));

    // ✅ FIXED: Keep existing photos that are NOT being replaced
    // If a photo with the same key is uploaded, it replaces the existing one
    const existingImages = shipment?.carId.images.filter(
      (img) => !newPhotosMap.has(img.key) // Keep photos that aren't being replaced
    );

    // ✅ FIXED: Add/Replace photos - same key = replace, new key = add
    // This ensures no duplicates - if same file name uploaded again, it replaces
    const updatedImages = [...existingImages];

    photos.forEach((p) => {
      // Check if this key already exists (shouldn't after filter, but double-check)
      const existingIndex = updatedImages.findIndex((img) => img.key === p.key);

      if (existingIndex >= 0) {
        // Replace existing photo with same key
        updatedImages[existingIndex] = {
          _id: updatedImages[existingIndex]._id, // Keep existing _id if any
          key: p.key,
          url: p.publicUrl,
          name: p.fileName,
          alt: updatedImages[existingIndex].alt || "Car photo",
        };
      } else {
        // Add new photo
        updatedImages.push({
          key: p.key,
          url: p.publicUrl,
          name: p.fileName,
          alt: "Car photo",
        });
      }
    });

    console.log(
      `✅ Confirmed upload for shipment ${shipmentFolderId}: ${photos.length} photos processed, total: ${updatedImages.length}`
    );

    // ✅ DOUBLE CHECK: Ensure we don't exceed 25 photos
    if (updatedImages.length > 25) {
      return res.status(400).json({
        message: `Photo limit exceeded. Would have ${updatedImages.length} photos after upload. Maximum 25 allowed.`,
      });
    }

    shipment.carId.images = updatedImages;
    await shipment.save();

    res.json({
      message: "Car photos updated successfully",
      shipment,
      photos: shipment.carId.images, // Return the photos array
      totalCount: shipment.carId.images.length,
    });
  } catch (err) {
    console.error("Error confirming upload:", err);
    res.status(500).json({ message: "Failed to confirm upload" });
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

    console.log("Keys to delete from S3:", keysToDelete);

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
    await shipment.save();

    res.json({
      message: "Selected photos deleted successfully",
      photos: shipment.carId.images, // updated shipment images
    });
  } catch (err) {
    console.error("Error deleting shipment photos:", err);
    res
      .status(500)
      .json({ message: "Failed to delete photos", success: false });
  }
};

exports.downloadCarPhotos = async (req, res) => {
  try {
    const { shipmentId } = req.query;

    if (!shipmentId || !mongoose.Types.ObjectId.isValid(shipmentId)) {
      return res.status(400).json({ message: "Invalid shipment ID" });
    }

    const shipment = await Shipment.findById(shipmentId);
    if (!shipment)
      return res.status(404).json({ message: "Shipment not found" });

    // ✅ FIXED: Use consistent folder ID format
    const shipmentFolderId = shipment._id.toString();

    // 1️⃣ List objects in S3 - only from the correct folder
    const listResult = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: `cars/${shipmentFolderId}/`,
      })
    );
    const objects = listResult.Contents || [];
    if (!objects.length)
      return res.status(404).json({ message: "No photos found" });

    // 2️⃣ Set headers for zip download
    const folderName = shipment.chassisNumber || shipmentFolderId;
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${folderName}_photos.zip"`
    );
    res.setHeader("Content-Type", "application/zip");

    // 3️⃣ Create zip archive
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);

    // 4️⃣ Append each S3 object stream to the archive
    const appendPromises = objects.map(async (obj) => {
      const { Body } = await s3.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: obj.Key,
        })
      );

      const fileName = obj.Key.split("/").pop();
      archive.append(Body, { name: `${shipmentFolderId}/${fileName}` });
    });

    // Wait for all streams to be appended
    await Promise.all(appendPromises);

    // 5️⃣ Finalize archive
    await archive.finalize();
  } catch (err) {
    console.error("Download error:", err);
    if (!res.headersSent) res.status(500).json({ message: "Server error" });
  }
};
