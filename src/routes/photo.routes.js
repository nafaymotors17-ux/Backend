const express = require("express");
const photoController = require("../controllers/shipment/photo.controller");
const router = express.Router();

// GET: generate signed URLs for direct S3 upload
router.post("/upload", photoController.generateSignedUrls);

// POST: confirm uploaded photos and update DB metadata
router.post("/confirm", photoController.confirmPhotoUpload);
router.get("/download", photoController.downloadCarPhotos);
router.post("/delete", photoController.deleteCarPhotos);
module.exports = router;
