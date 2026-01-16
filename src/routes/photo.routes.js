const express = require("express");
const photoController = require("../controllers/shipment/photo.controller");
const jwtMiddleware = require("../middlewares/jwt.middleware");
const asyncHandler = require("../utils/asyncHandler");
const router = express.Router();

// POST: generate signed URLs for direct S3 upload
router.post(
  "/upload",
  jwtMiddleware,
  asyncHandler(photoController.generateSignedUrls)
);

// POST: confirm uploaded photos and update DB metadata
router.post(
  "/confirm",
  jwtMiddleware,
  asyncHandler(photoController.confirmPhotoUpload)
);

// ZIP upload routes removed - no longer needed

// GET: download photos - requires authentication
router.get(
  "/download",
  jwtMiddleware,
  asyncHandler(photoController.downloadCarPhotos)
);

// POST: delete photos
router.post(
  "/delete",
  jwtMiddleware,
  asyncHandler(photoController.deleteCarPhotos)
);

module.exports = router;
