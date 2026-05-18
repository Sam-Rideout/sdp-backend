const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const app = express();

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const FFMPEG_PATH = 'G:\\Working\\FFMpeg\\ffmpeg-2026\\bin\\ffmpeg.exe';
const RUBBERBAND_PATH = 'G:\\Working\\Software\\rubberband\\rubberband.exe';

const PITCH_SHIFT_SEMITONES = '2';

const uploadFolder = path.join(__dirname, 'uploads');
const wavFolder = path.join(__dirname, 'wav');
const processedFolder = path.join(__dirname, 'processed');
const finalFolder = path.join(__dirname, 'final');
const masterFolder = path.join(__dirname, 'master');

const MASTER_SONG = path.join(masterFolder, 'master_song.wav');

[
    uploadFolder,
    wavFolder,
    processedFolder,
    finalFolder,
    masterFolder
].forEach(folder => {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder);
    }
});

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

function convertToWav(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        execFile(FFMPEG_PATH, [
            '-y',
            '-i', inputPath,
            '-ar', '44100',
            '-ac', '1',
            outputPath
        ], (error, stdout, stderr) => {
            if (error) {
                console.error('FFmpeg error:');
                console.error(stderr);
                reject(error);
                return;
            }

            resolve();
        });
    });
}

function processWithRubberBand(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        execFile(RUBBERBAND_PATH, [
            '-p', PITCH_SHIFT_SEMITONES,
            inputPath,
            outputPath
        ], (error, stdout, stderr) => {
            if (error) {
                console.error('Rubber Band error:');
                console.error(stderr);
                reject(error);
                return;
            }

            resolve();
        });
    });
}

function concatAudio(masterSong, nameAudio, outputFile) {
    return new Promise((resolve, reject) => {
        execFile(FFMPEG_PATH, [

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

        ], (error, stdout, stderr) => {
            if (error) {
                console.error('Concat error:');
                console.error(stderr);
                reject(error);
                return;
            }

            resolve();
        });
    });
}

app.post('/upload', upload.single('audio'), async (req, res) => {
    try {
        console.log('File received:');
        console.log(req.file);

        const inputPath = req.file.path;
        const baseName = req.file.filename.replace(/\.[^/.]+$/, '');

        const wavFilename = baseName + '.wav';
        const processedFilename = baseName + '_pitch_plus_2.wav';
        const finalFilename = baseName + '_final.mp3';

        const wavPath = path.join(wavFolder, wavFilename);
        const processedPath = path.join(processedFolder, processedFilename);
        const finalPath = path.join(finalFolder, finalFilename);

        await convertToWav(inputPath, wavPath);

        console.log('Converted to WAV');

        await processWithRubberBand(wavPath, processedPath);

        console.log('Rubber Band complete');

        await concatAudio(MASTER_SONG, processedPath, finalPath);

        console.log('Final song created');

        res.json({
            success: true,
            finalSong: finalFilename
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: 'Processing failed'
        });
    }
});

const PORT = 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});