# Vessel Migration Guide

This guide explains how to migrate existing vessel data from the Shipment model to the new Vessel entity.

## Overview

The migration process:
1. Extracts unique vessel combinations (vesselName + jobNumber + pod) from shipments
2. Creates Vessel documents for each unique combination
3. Links shipments to vessels via `vesselId`
4. Preserves all existing data (vesselName, pod, jobNumber remain in shipments)

## Migration Steps

### Step 1: Analyze Current State

**API Endpoint:** `GET /api/admin/migration/analyze`

This endpoint shows:
- How many shipments need migration
- How many are already migrated
- Unique vessel combinations that will be created
- Existing vessels in the database

**Frontend:** Navigate to `/admin/migration` and click "Refresh Analysis"

### Step 2: Dry Run (Recommended)

**API Endpoint:** `POST /api/admin/migration/execute?dryRun=true`

This simulates the migration without making any changes. Review the results to ensure everything looks correct.

**Frontend:** Click "Dry Run" button

### Step 3: Execute Migration

**API Endpoint:** `POST /api/admin/migration/execute`

This performs the actual migration:
- Creates Vessel documents for unique combinations
- Updates shipments with `vesselId` references
- Preserves existing `vesselName`, `pod`, and `jobNumber` fields

**Frontend:** Click "Execute Migration" button

### Step 4: Verify Migration

**API Endpoint:** `GET /api/admin/migration/verify`

This checks:
- All shipments are migrated
- No orphaned vesselIds
- Data integrity (vesselName matches vessel.vesselName)

**Frontend:** Switch to "Verify" tab and click "Verify Migration"

### Step 5: Test Application

After migration, thoroughly test:
- Shipment listing and filtering
- Vessel assignment functionality
- Bulk operations
- Data display in tables

### Step 6: Cleanup (After Verification)

**⚠️ WARNING: This is IRREVERSIBLE!**

Only run this after:
- Migration is verified
- Application is tested thoroughly
- You're confident the new system works correctly

**API Endpoint:** `POST /api/admin/migration/cleanup?confirm=true&verifyFirst=true`

This removes `vesselName`, `pod`, and `jobNumber` fields from shipments.

**Frontend:** Click "Cleanup Old Fields" button (only after verification passes)

## Rollback

If you need to rollback the migration:

**API Endpoint:** `POST /api/admin/migration/rollback?confirm=true`

This removes `vesselId` references from shipments but keeps Vessel documents. You can re-run migration later.

**Frontend:** Click "Rollback Migration" button

## Migration Logic

### Vessel Creation

Vessels are created based on unique combinations of:
- `vesselName` (required)
- `jobNumber` (optional)
- `pod` (optional)

If multiple shipments have the same combination, they all reference the same Vessel document.

### Data Preservation

During migration:
- ✅ Existing `vesselName`, `pod`, `jobNumber` fields remain in shipments
- ✅ New `vesselId` field is added
- ✅ Vessel documents are created
- ✅ No data is deleted

### Edge Cases Handled

- Empty/null vesselName: Skipped (not migrated)
- Duplicate vessel combinations: Single Vessel created, all shipments linked
- Missing jobNumber/pod: Handled as null/undefined
- Case sensitivity: Normalized to uppercase

## API Endpoints Summary

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/migration/analyze` | GET | Analyze migration status |
| `/api/admin/migration/execute?dryRun=true` | POST | Simulate migration |
| `/api/admin/migration/execute` | POST | Execute migration |
| `/api/admin/migration/verify` | GET | Verify migration |
| `/api/admin/migration/rollback?confirm=true` | POST | Rollback migration |
| `/api/admin/migration/cleanup?confirm=true` | POST | Remove old fields |

## Best Practices

1. **Backup First**: Always backup your database before migration
2. **Test in Staging**: Run migration in staging environment first
3. **Dry Run**: Always run dry run before actual migration
4. **Verify**: Always verify after migration
5. **Test Thoroughly**: Test all functionality before cleanup
6. **Monitor**: Monitor application after migration
7. **Wait**: Wait at least 1-2 weeks before cleanup to ensure stability

## Troubleshooting

### Migration Fails

- Check error logs in response
- Verify database connection
- Ensure sufficient permissions
- Check for data inconsistencies

### Verification Fails

- Review sample mismatches
- Check for orphaned vesselIds
- Verify vessel documents exist
- Check data integrity

### Rollback Needed

- Use rollback endpoint
- Vessel documents remain (can re-migrate)
- Old fields are preserved

## Post-Migration

After successful migration and verification:

1. Monitor application for 1-2 weeks
2. Ensure all features work correctly
3. Verify data integrity periodically
4. Once confident, run cleanup to remove old fields
5. Update any external systems that might reference old fields

