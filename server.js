// server.js

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const cors = require('cors');
const tar = require('tar');

const app = express();
const port = process.env.PORT || 3000; // Render provides the PORT environment variable

// Enable CORS for all routes
app.use(cors());

// Serve the frontend HTML file and uploaded data files
app.use(express.static(path.join(__dirname, 'public')));

// Set up storage for uploaded files using Multer
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)){
        fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir); 
  },
  filename: function (req, file, cb) {
    // Keep the original filename
    cb(null, file.originalname); 
  }
});

const upload = multer({ storage: storage });

// Define the file upload endpoint to handle multiple files
app.post('/upload', upload.array('genomicFiles'), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded.' });
  }

  const archiveFile = req.files.find(f => f.originalname.endsWith('.tar.gz'));
  const libraryFiles = req.files.filter(f => ['.bam', '.bai', '.mcool'].some(ext => f.originalname.endsWith(ext)));
  const processableFile = req.files.find(f => !archiveFile && libraryFiles.length === 0);

  // 1. Handle Archives
  if (archiveFile) {
    const archivePath = archiveFile.path;
    const extractPath = path.join('uploads', Date.now().toString());
    fs.mkdirSync(extractPath);

    tar.x({ file: archivePath, cwd: extractPath, sync: true });
    
    const filesInArchive = fs.readdirSync(extractPath);
    const fileToProcess = filesInArchive.find(f => ['.csv', '.bed', '.vcf'].some(ext => f.endsWith(ext)));

    if (!fileToProcess) {
      fs.rm(extractPath, { recursive: true, force: true }, () => {});
      return res.status(400).json({ error: 'No processable file found in the archive.' });
    }

    const processableFilePath = path.join(extractPath, fileToProcess);
    const fileExtension = path.extname(fileToProcess).toLowerCase();

    processFile(processableFilePath, fileExtension, (err, data) => {
      fs.unlinkSync(archivePath);
      fs.rm(extractPath, { recursive: true, force: true }, () => {});
      if (err) return res.status(500).json({ error: err.message });
      res.json(data);
    });
  
  // 2. Handle Library-Specific Files (BAM, mcool, etc.)
  } else if (libraryFiles.length > 0) {
    libraryFiles.forEach(file => {
        const publicDir = path.join(__dirname, 'public', 'data');
        if (!fs.existsSync(publicDir)) {
            fs.mkdirSync(publicDir, { recursive: true });
        }
        const newPath = path.join(publicDir, file.originalname);
        fs.renameSync(file.path, newPath);
    });
    res.json({ 
        message: 'Library-specific files uploaded successfully.',
        files: req.files.map(f => ({ name: f.originalname, originalname: f.originalname }))
    });

  // 3. Handle Single Processable Files (CSV, BED, VCF)
  } else if (processableFile) {
    const filePath = processableFile.path;
    const fileExtension = path.extname(processableFile.originalname).toLowerCase();
    
    processFile(filePath, fileExtension, (err, data) => {
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) console.error("Error deleting temp file:", unlinkErr);
      });

      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(data);
    });

  } else {
    res.status(400).json({ error: 'No valid file type for processing found.' });
  }
});

function processFile(filePath, fileExtension, callback) {
  const results = [];
  let headers = [];
  let isHeader = true;

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    if (line.startsWith('##')) return;
    if (line.startsWith('#CHROM')) {
        headers = line.split('\t');
        isHeader = false;
        return;
    }

    const values = line.split(fileExtension === '.csv' ? ',' : '\t');

    if (isHeader && fileExtension === '.csv') {
      headers = values.map(h => h.trim());
      isHeader = false;
      return;
    }
    
    if (isHeader && fileExtension === '.bed') {
        headers = values.map((_, i) => `col${i}`);
        isHeader = false;
    }

    let obj = {};
    headers.forEach((header, i) => {
      const cleanHeader = (typeof header === 'string') ? header.trim() : `col${i}`;
      obj[cleanHeader] = values[i];
    });
    results.push(obj);
  });

  rl.on('close', () => {
    const finalData = results;
    finalData.columns = headers;
    callback(null, finalData);
  });

  rl.on('error', (err) => {
    callback(err, null);
  });
}

app.listen(port, () => {
  console.log(`Genomic Analyzer server listening on port ${port}`);
});
