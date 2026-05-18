const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const app = express();

const isWindows = process.platform === 'win32';

const FFMPEG_PATH = isWindows
    ? 'G:\\Working\\FFMpeg\\ffmpeg-2026\\bin\\ffmpeg.exe'
    : 'ffmpeg';

const uploadFolder = path.join(__dirname, 'uploads');
const wavFolder = path.join(__dirname, 'wav');
const finalFolder = path.join(__dirname, 'final');
const masterFolder = path.join(__dirname, 'master');

const MASTER_SONG = path.join(masterFolder, 'master_song.wav');

[
    uploadFolder,
    wavFolder,
    finalFolder,
    masterFolder
].forEach(folder => {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder);
    }
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadFolder);
    },

    filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-z0-9.\-_]/gi, '_');
        cb(null, safeName);
    }
});

const upload = multer({ storage });

function deleteFileIfExists(filePath) {
    if (filePath && fs.existsSync(filePath)) {
        fs.unlink(filePath, error => {
            if (error) {
                console.error('File cleanup failed:', filePath);
                console.error(error.message);
            } else {
                console.log('Deleted:', filePath);
            }
        });
    }
}

function runCommand(command, args, label) {
    return new Promise((resolve, reject) => {
        console.log(`Running ${label}:`);
        console.log(command, args.join(' '));

        execFile(command, args, (error, stdout, stderr) => {
            if (stdout) {
                console.log(`${label} stdout:`);
                console.log(stdout);
            }

            if (stderr) {
                console.log(`${label} stderr:`);
                console.log(stderr);
            }

            if (error) {
                console.error(`${label} failed:`);
                console.error(error);

                reject(new Error(`${label} failed: ${error.message}`));
                return;
            }

            resolve();
        });
    });
}

function convertToWav(inputPath, outputPath) {
    return runCommand(FFMPEG_PATH, [
        '-y',
        '-i', inputPath,
        '-ar', '44100',
        '-ac', '1',
        outputPath
    ], 'FFmpeg convert');
}

function concatAudio(masterSong, nameAudio, outputFile) {
    return runCommand(FFMPEG_PATH, [
        '-y',

        '-i', masterSong,
        '-i', nameAudio,

        '-filter_complex',
        '[0:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=mono[a0];' +
        '[1:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=mono[a1];' +
        '[a0][a1]concat=n=2:v=0:a=1[out]',

        '-map', '[out]',
        '-acodec', 'libmp3lame',
        '-b:a', '192k',

        outputFile
    ], 'FFmpeg concat');
}

app.post('/upload', upload.single('audio'), async (req, res) => {
    let inputPath = null;
    let wavPath = null;

    try {
        console.log('Upload route hit.');

        if (!req.file) {
            throw new Error('No audio file received.');
        }

        console.log('File received:');
        console.log(req.file);

        if (!fs.existsSync(MASTER_SONG)) {
            throw new Error('Master song not found at: ' + MASTER_SONG);
        }

        inputPath = req.file.path;

        const baseName = req.file.filename.replace(/\.[^/.]+$/, '');
        const wavFilename = baseName + '.wav';
        const finalFilename = baseName + '_final.mp3';

        wavPath = path.join(wavFolder, wavFilename);
        const finalPath = path.join(finalFolder, finalFilename);

        await convertToWav(inputPath, wavPath);

        console.log('Converted to WAV');

        await concatAudio(MASTER_SONG, wavPath, finalPath);

        console.log('Final song created');

        deleteFileIfExists(inputPath);
        deleteFileIfExists(wavPath);

        res.json({
            success: true,
            finalSong: finalFilename,
            finalSongUrl: `/download/${encodeURIComponent(finalFilename)}`
        });

    } catch (error) {
        console.error('Processing failed:');
        console.error(error.message);

        deleteFileIfExists(inputPath);
        deleteFileIfExists(wavPath);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/download/:filename', (req, res) => {
    const safeFilename = path.basename(req.params.filename);
    const filePath = path.join(finalFolder, safeFilename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).send('File not found or already downloaded.');
    }

    res.download(filePath, safeFilename, error => {
        if (error) {
            console.error('Download error:');
            console.error(error.message);
        }

        deleteFileIfExists(filePath);
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});