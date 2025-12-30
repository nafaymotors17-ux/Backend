const fs = require('fs/promises');


exports.deleteTempFiles = async (files) => {
    for (const file of files) {
        try {
            await fs.unlink(file.path);
        } catch (err) {
            console.error('Failed to delete temp file:', file.path);
        }
    }
};
