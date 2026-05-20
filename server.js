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

const FFPROBE_PATH = isWindows
    ? 'G:\\Working\\FFMpeg\\ffmpeg-2026\\bin\\ffprobe.exe'
    : 'ffprobe';

const uploadFolder = path.join(__dirname, 'uploads');
const finalFolder = path.join(__dirname, 'final');
const masterFolder = path.join(__dirname, 'master');
const processedFolder = path.join(__dirname, 'processed');

const MASTER_SONG = path.join(masterFolder, 'master_song.wav');

const NAME_START_MS = 18000;
const CHORD_START_MS = 16250;
const CHORD_DURATION_SECONDS = 8;

const NAME_GAIN = 1.0;
const CHORD_GAIN = 0.07;
const MASTER_GAIN = 1.0;
const END_TAIL_SECONDS = 1.5;

[
    uploadFolder,
    finalFolder,
    masterFolder,
    processedFolder
].forEach(folder => {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder);
    }
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadFolder),

    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const safeName = file.originalname.replace(/[^a-z0-9.\-_]/gi, '_');
        cb(null, `${timestamp}_${safeName}`);
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

function makeCleanDownloadName(internalFilename) {

    let cleanName = internalFilename
        .replace(/^\d+_/, '')
        .replace(/_final\.mp3$/i, '')
        .replace(/\.[^/.]+$/, '')
        .replace(/_recording$/i, '')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '');

    if (!cleanName) {
        cleanName = 'Song';
    }

    return `Happy-Birthday-${cleanName}.mp3`;
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

function getAudioDuration(filePath) {

    return new Promise((resolve, reject) => {

        execFile(
            FFPROBE_PATH,
            [
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                filePath
            ],

            (error, stdout) => {

                if (error) {
                    reject(error);
                    return;
                }

                resolve(parseFloat(stdout.trim()));
            }
        );
    });
}

function convertToCleanWav(inputPath, outputPath) {

    return runCommand(FFMPEG_PATH, [

        '-y',
        '-i', inputPath,

        '-ar', '48000',
        '-ac', '1',

        '-af',

        [
            'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.10',
            'areverse',
            'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.10',
            'areverse',
            'highpass=f=120',
            'lowpass=f=8000',
            'loudnorm=I=-22:TP=-3:LRA=9',

            'acompressor=threshold=-20dB:ratio=1.8:attack=8:release=120:makeup=2.5',

            'aecho=0.8:0.18:35:0.08',

            `volume=${NAME_GAIN}`

        ].join(','),

        outputPath

    ], 'FFmpeg clean vocal');
}

function mixNameWithGeneratedChord(
    masterSong,
    nameAudio,
    outputFile,
    finalDuration
) {

    console.log('*** USING POLISHED PERSONALIZED MIX ENGINE ***');

    const fadeStart = Math.max(
        0,
        finalDuration - 0.7
    );

    return runCommand(FFMPEG_PATH, [

        '-y',

        '-i', masterSong,
        '-i', nameAudio,

        '-filter_complex',

        [

            `[0:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono,volume=${MASTER_GAIN}[master]`,

            `[1:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono,adelay=${NAME_START_MS}|${NAME_START_MS},volume=${NAME_GAIN}[name]`,

            `sine=frequency=146.83:duration=${CHORD_DURATION_SECONDS}:sample_rate=48000[d_low]`,
            `sine=frequency=293.66:duration=${CHORD_DURATION_SECONDS}:sample_rate=48000[d]`,
            `sine=frequency=369.99:duration=${CHORD_DURATION_SECONDS}:sample_rate=48000[fs]`,
            `sine=frequency=440.00:duration=${CHORD_DURATION_SECONDS}:sample_rate=48000[a]`,

            `[d_low][d][fs][a]amix=inputs=4:duration=longest:normalize=0,volume=${CHORD_GAIN},afade=t=in:st=0:d=0.15,afade=t=out:st=5.3:d=2.7[chordraw]`,

            `[chordraw]adelay=${CHORD_START_MS}|${CHORD_START_MS}[chord]`,

            '[master][name][chord]amix=inputs=3:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[mixed]',

            `[mixed]afade=t=out:st=${fadeStart}:d=0.7[out]`

        ].join(';'),

        '-map', '[out]',

        '-t', finalDuration.toString(),

        '-acodec', 'libmp3lame',
        '-b:a', '192k',

        outputFile

    ], 'FFmpeg polished personalized mix');
}

app.post('/upload', upload.single('audio'), async (req, res) => {

    let inputPath = null;
    let cleanWavPath = null;

    try {

        console.log('Upload route hit.');

        if (!req.file) {
            throw new Error('No audio file received.');
        }

        if (!fs.existsSync(MASTER_SONG)) {
            throw new Error('Master song not found at: ' + MASTER_SONG);
        }

        inputPath = req.file.path;

        const baseName = req.file.filename.replace(/\.[^/.]+$/, '');

        const cleanWavFilename = baseName + '_clean.wav';
        const finalFilename = baseName + '_final.mp3';

        cleanWavPath = path.join(
            processedFolder,
            cleanWavFilename
        );

        const finalPath = path.join(
            finalFolder,
            finalFilename
        );

        await convertToCleanWav(
            inputPath,
            cleanWavPath
        );

        console.log('Name vocal cleaned and converted to WAV');

        const nameDuration = await getAudioDuration(cleanWavPath);

        console.log('Clean name duration:', nameDuration);

        const finalDuration =
            (NAME_START_MS / 1000) +
            nameDuration +
            END_TAIL_SECONDS;

        console.log('Final output duration:', finalDuration);

        await mixNameWithGeneratedChord(
            MASTER_SONG,
            cleanWavPath,
            finalPath,
            finalDuration
        );

        console.log('Final song created');

        deleteFileIfExists(inputPath);
        deleteFileIfExists(cleanWavPath);

        res.json({
            success: true,
            finalSong: finalFilename,
            downloadFilename: makeCleanDownloadName(finalFilename),
            finalSongUrl: `/download/${encodeURIComponent(finalFilename)}`
        });

    } catch (error) {

        console.error('Processing failed:');
        console.error(error.message);

        deleteFileIfExists(inputPath);
        deleteFileIfExists(cleanWavPath);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/download/:filename', (req, res) => {

    const safeFilename = path.basename(req.params.filename);

    const filePath = path.join(
        finalFolder,
        safeFilename
    );

    const downloadFilename =
        makeCleanDownloadName(safeFilename);

    if (!fs.existsSync(filePath)) {

        return res
            .status(404)
            .send('File not found or already downloaded.');
    }

    res.download(
        filePath,
        downloadFilename,

        error => {

            if (error) {
                console.error('Download error:');
                console.error(error.message);
            }

            deleteFileIfExists(filePath);
        }
    );
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});