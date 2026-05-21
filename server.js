const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const path = require('path');

app.use('/chords', express.static(path.join(__dirname, 'chords')));


const app = express();

const isWindows = process.platform === 'win32';

const FFMPEG_PATH = isWindows
    ? 'G:\\Working\\FFMpeg\\ffmpeg-2026\\bin\\ffmpeg.exe'
    : 'ffmpeg';

const FFPROBE_PATH = isWindows
    ? 'G:\\Working\\FFMpeg\\ffmpeg-2026\\bin\\ffprobe.exe'
    : 'ffprobe';

const NULL_OUTPUT = isWindows ? 'NUL' : '/dev/null';

const uploadFolder = path.join(__dirname, 'uploads');
const finalFolder = path.join(__dirname, 'final');
const masterFolder = path.join(__dirname, 'master');
const processedFolder = path.join(__dirname, 'processed');
const chordFolder = path.join(__dirname, 'chords');

const PREVIEW_TAG = path.join(masterFolder, 'preview_tag.wav');

const NAME_START_MS = 57732;
const CHORD_START_MS = 56380;
const CHORD_DURATION_SECONDS = 8;

const NAME_GAIN = 1.7;
const CHORD_GAIN = 0.06;
const MASTER_GAIN = 1.0;
const END_TAIL_SECONDS = 1.5;

const MIN_NAME_SECONDS = 0.4;
const MAX_NAME_SECONDS = 6.0;
const TOO_QUIET_DB = -30;
const CLIPPED_DB = -0.5;

const TEMP_FILE_MAX_AGE_MINUTES = 10;
const CLEANUP_INTERVAL_MINUTES = 10;
const DOWNLOAD_DELETE_DELAY_MS = 120000;

const usedPreviewFiles = new Set();

[
    uploadFolder,
    finalFolder,
    masterFolder,
    processedFolder,
    chordFolder
].forEach(folder => {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder);
    }
});

app.use(cors());
app.use(express.json({ limit: '25mb' }));

app.use(
    express.static(
        path.join(__dirname, 'public')
    )
);

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadFolder);
    },

    filename: (req, file, cb) => {
        const timestamp = Date.now();

        const safeName = file.originalname.replace(
            /[^a-z0-9.\-_]/gi,
            '_'
        );

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

function cleanupOldFiles(folder, maxAgeMinutes) {
    const maxAgeMs = maxAgeMinutes * 60 * 1000;

    fs.readdir(folder, (readError, files) => {
        if (readError) {
            return;
        }

        files.forEach(file => {
            const filePath = path.join(folder, file);

            fs.stat(filePath, (statError, stats) => {
                if (statError || !stats.isFile()) {
                    return;
                }

                const ageMs = Date.now() - stats.mtimeMs;

                if (ageMs > maxAgeMs) {
                    fs.unlink(filePath, unlinkError => {
                        if (!unlinkError) {
                            console.log('Cleaned old temp file:', filePath);
                        }
                    });
                }
            });
        });
    });
}

function runScheduledCleanup() {
    cleanupOldFiles(uploadFolder, TEMP_FILE_MAX_AGE_MINUTES);
    cleanupOldFiles(processedFolder, TEMP_FILE_MAX_AGE_MINUTES);
    cleanupOldFiles(finalFolder, TEMP_FILE_MAX_AGE_MINUTES);
}

function makeCleanDownloadName(internalFilename) {
    let cleanName = internalFilename
        .replace(/^\d+_/, '')
        .replace(/_preview\.mp3$/i, '')
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

                reject(
                    new Error(`${label} failed: ${error.message}`)
                );

                return;
            }

            resolve({
                stdout,
                stderr
            });
        });
    });
}

function downloadFile(url, outputPath) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const file = fs.createWriteStream(outputPath);

        https.get(url, response => {
            if (response.statusCode !== 200) {
                reject(new Error(`Download failed with status ${response.statusCode}`));
                return;
            }

            response.pipe(file);

            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', error => {
            deleteFileIfExists(outputPath);
            reject(error);
        });
    });
}

function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        execFile(
            FFPROBE_PATH,
            [
                '-v',
                'error',
                '-show_entries',
                'format=duration',
                '-of',
                'default=noprint_wrappers=1:nokey=1',
                filePath
            ],
            (error, stdout) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve(
                    parseFloat(stdout.trim())
                );
            }
        );
    });
}

function analyzeAudioVolume(filePath) {
    return new Promise((resolve, reject) => {
        execFile(
            FFMPEG_PATH,
            [
                '-i',
                filePath,
                '-af',
                'volumedetect',
                '-f',
                'null',
                NULL_OUTPUT
            ],
            (error, stdout, stderr) => {
                const output = `${stdout}\n${stderr}`;

                const maxMatch = output.match(
                    /max_volume:\s*(-?\d+(\.\d+)?) dB/i
                );

                const meanMatch = output.match(
                    /mean_volume:\s*(-?\d+(\.\d+)?) dB/i
                );

                if (!maxMatch) {
                    reject(
                        new Error('Could not analyze recording volume.')
                    );

                    return;
                }

                resolve({
                    maxVolumeDb: parseFloat(maxMatch[1]),
                    meanVolumeDb: meanMatch
                        ? parseFloat(meanMatch[1])
                        : null
                });
            }
        );
    });
}

function validateRecordingQuality(duration, volumeInfo) {
    if (duration < MIN_NAME_SECONDS) {
        throw new Error(
            'Recording is too short. Please sing the name clearly.'
        );
    }

    if (duration > MAX_NAME_SECONDS) {
        throw new Error(
            'Recording is too long. Please sing only the first name.'
        );
    }

    if (volumeInfo.maxVolumeDb < TOO_QUIET_DB) {
        throw new Error(
            'Recording is too quiet. Please sing closer to the microphone.'
        );
    }

    if (volumeInfo.maxVolumeDb > CLIPPED_DB) {
        throw new Error(
            'Recording is too loud or distorted. Please sing softer or farther from the microphone.'
        );
    }
}

function convertToCleanWav(inputPath, outputPath, nameGain) {
    return runCommand(
        FFMPEG_PATH,
        [
            '-y',
            '-i',
            inputPath,
            '-ar',
            '48000',
            '-ac',
            '1',
            '-af',
            [
                'silenceremove=start_periods=1:start_threshold=-36dB:start_silence=0.12',
                'areverse',
                'silenceremove=start_periods=1:start_threshold=-38dB:start_silence=0.20',
                'areverse',
                'highpass=f=120',
                'lowpass=f=8000',
                'loudnorm=I=-22:TP=-3:LRA=9',
                'acompressor=threshold=-20dB:ratio=1.8:attack=8:release=120:makeup=2.5',
                'aecho=0.8:0.18:35:0.08',
                `volume=${nameGain}`
            ].join(','),
            outputPath
        ],
        'FFmpeg clean vocal'
    );
}

function mixNameWithChordFile(
    masterSong,
    nameAudio,
    chordFile,
    outputFile,
    finalDuration,
    settings
) {
    console.log('*** USING TEMPLATE FINAL MIX ENGINE ***');

    const nameStartMs = settings.nameStartMs;
    const chordStartMs = settings.chordStartMs;
    const nameGain = settings.nameGain;
    const chordGain = settings.chordGain;
    const masterGain = settings.masterGain;

    const fadeStart = Math.max(
        0,
        finalDuration - 0.7
    );

    return runCommand(
        FFMPEG_PATH,
        [
            '-y',

            '-i',
            masterSong,

            '-i',
            nameAudio,

            '-i',
            chordFile,

            '-filter_complex',
            [
                `[0:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono,volume=${masterGain}[master]`,

                `[1:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono,adelay=${nameStartMs}|${nameStartMs},volume=${nameGain}[name]`,

                `[2:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono,volume=${chordGain},afade=t=in:st=0:d=0.15,afade=t=out:st=5.3:d=2.7,adelay=${chordStartMs}|${chordStartMs}[chord]`,

                '[master][name][chord]amix=inputs=3:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[mixed]',

                `[mixed]afade=t=out:st=${fadeStart}:d=0.7[out]`
            ].join(';'),

            '-map',
            '[out]',

            '-t',
            finalDuration.toString(),

            '-acodec',
            'libmp3lame',

            '-b:a',
            '192k',

            outputFile
        ],
        'FFmpeg template final mix'
    );
}

function createPreviewWithTag(
    cleanFinalPath,
    previewOutputPath
) {
    if (!fs.existsSync(PREVIEW_TAG)) {
        console.warn(
            'Preview tag file missing. Creating preview without voice tag:',
            PREVIEW_TAG
        );

        return runCommand(
            FFMPEG_PATH,
            [
                '-y',

                '-i',
                cleanFinalPath,

                '-filter_complex',

                '[0:a]volume=0.92[out]',

                '-map',
                '[out]',

                '-acodec',
                'libmp3lame',

                '-b:a',
                '192k',

                previewOutputPath
            ],

            'FFmpeg preview copy without tag'
        );
    }

    return runCommand(
        FFMPEG_PATH,
        [
            '-y',

            '-i',
            cleanFinalPath,

            '-i',
            PREVIEW_TAG,

            '-filter_complex',

            [
                '[0:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono,volume=0.92[main]',

                '[1:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono,volume=0.9,adelay=2500|2500[tag1]',

                '[1:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono,volume=0.66,adelay=9000|9000[tag2]',

                '[main][tag1][tag2]amix=inputs=3:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[out]'
            ].join(';'),

            '-map',
            '[out]',

            '-acodec',
            'libmp3lame',

            '-b:a',
            '192k',

            previewOutputPath
        ],

        'FFmpeg watermarked preview'
    );
}

app.post('/render-from-wix', async (req, res) => {
    try {
        console.log('Wix render payload:', req.body);

        const payload = req.body;

        const inputPath = path.join(
            uploadFolder,
            `wix_${Date.now()}.wav`
        );

        await downloadFile(
            payload.nameAudioUrl,
            inputPath
        );

        res.json({
            success: true,
            message: 'Audio downloaded successfully.'
        });

    } catch (err) {
        console.error(err);

        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.post(
    '/upload',
    upload.single('audio'),
    async (req, res) => {
        let inputPath = null;
        let cleanWavPath = null;
        let finalPath = null;
        let previewPath = null;

        try {
            console.log('Upload route hit.');
            console.log('REQ BODY:', req.body);

            if (!req.file) {
                throw new Error('No audio file received.');
            }

            const selectedMasterSong = path.join(
                masterFolder,
                req.body.masterSong || 'master_song.wav'
            );

            const selectedChordFile = path.join(
                chordFolder,
                req.body.nameChord || 'D_major.wav'
            );


            console.log('REQ BODY:', req.body);
            console.log('Selected master from request:', req.body.masterSong);
            console.log('Selected chord from request:', req.body.nameChord);
            console.log('Selected master full path:', selectedMasterSong);
            console.log('Selected chord full path:', selectedChordFile);



            
            const nameStartMs = req.body.insertionPoint
                ? Math.round(parseFloat(req.body.insertionPoint) * 1000)
                : NAME_START_MS;

            const chordStartMs = Math.max(
                0,
                nameStartMs - 1352
            );

            const nameGain = req.body.nameGain
                ? parseFloat(req.body.nameGain)
                : NAME_GAIN;

            const chordGain = req.body.chordGain
                ? parseFloat(req.body.chordGain)
                : CHORD_GAIN;

            const masterGain = req.body.masterGain
                ? parseFloat(req.body.masterGain)
                : MASTER_GAIN;

            console.log('Selected master from request:', req.body.masterSong);
            console.log('Selected chord from request:', req.body.nameChord);
            console.log('Selected master full path:', selectedMasterSong);
            console.log('Selected chord full path:', selectedChordFile);
            console.log('Name start ms:', nameStartMs);
            console.log('Chord start ms:', chordStartMs);
            console.log('Name gain:', nameGain);
            console.log('Chord gain:', chordGain);
            console.log('Master gain:', masterGain);

            if (!fs.existsSync(selectedMasterSong)) {
                throw new Error(
                    'Selected master song not found at: ' + selectedMasterSong
                );
            }

            if (!fs.existsSync(selectedChordFile)) {
                throw new Error(
                    'Selected chord file not found at: ' + selectedChordFile
                );
            }

            inputPath = req.file.path;

            const baseName = req.file.filename.replace(
                /\.[^/.]+$/,
                ''
            );

            const cleanWavFilename =
                baseName + '_clean.wav';

            const finalFilename =
                baseName + '_final.mp3';

            const previewFilename =
                baseName + '_preview.mp3';

            cleanWavPath = path.join(
                processedFolder,
                cleanWavFilename
            );

            finalPath = path.join(
                finalFolder,
                finalFilename
            );

            previewPath = path.join(
                finalFolder,
                previewFilename
            );

            await convertToCleanWav(
                inputPath,
                cleanWavPath,
                nameGain
            );

            const nameDuration =
                await getAudioDuration(cleanWavPath);

            const volumeInfo =
                await analyzeAudioVolume(cleanWavPath);

            console.log(
                'Clean name duration:',
                nameDuration
            );

            console.log(
                'Volume analysis:',
                volumeInfo
            );

            validateRecordingQuality(
                nameDuration,
                volumeInfo
            );

            const finalDuration =
                (nameStartMs / 1000) +
                nameDuration +
                END_TAIL_SECONDS;

            await mixNameWithChordFile(
                selectedMasterSong,
                cleanWavPath,
                selectedChordFile,
                finalPath,
                finalDuration,
                {
                    nameStartMs,
                    chordStartMs,
                    nameGain,
                    chordGain,
                    masterGain
                }
            );

            await createPreviewWithTag(
                finalPath,
                previewPath
            );

            deleteFileIfExists(inputPath);
            deleteFileIfExists(cleanWavPath);

            res.json({
                success: true,

                finalSong: finalFilename,

                previewSong: previewFilename,

                downloadFilename:
                    makeCleanDownloadName(finalFilename),

                previewUrl:
                    `/preview/${encodeURIComponent(previewFilename)}`,

                finalSongUrl:
                    `/download/${encodeURIComponent(finalFilename)}`
            });

        } catch (error) {
            console.error('Processing failed:');
            console.error(error.message);

            deleteFileIfExists(inputPath);
            deleteFileIfExists(cleanWavPath);
            deleteFileIfExists(finalPath);
            deleteFileIfExists(previewPath);

            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }
);

app.get('/preview/:filename', (req, res) => {
    const safeFilename = path.basename(
        req.params.filename
    );

    const filePath = path.join(
        finalFolder,
        safeFilename
    );

    if (!fs.existsSync(filePath)) {
        return res
            .status(404)
            .send('Preview file not found.');
    }

    if (usedPreviewFiles.has(safeFilename)) {
        return res
            .status(410)
            .send('Preview already played.');
    }

    usedPreviewFiles.add(safeFilename);

    res.sendFile(filePath);
});

app.get('/download/:filename', (req, res) => {
    const safeFilename = path.basename(
        req.params.filename
    );

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
                return;
            }

            console.log(
                'Download completed:',
                downloadFilename
            );

            setTimeout(() => {
                deleteFileIfExists(filePath);
            }, DOWNLOAD_DELETE_DELAY_MS);
        }
    );
});

runScheduledCleanup();

setInterval(() => {
    runScheduledCleanup();
}, CLEANUP_INTERVAL_MINUTES * 60 * 1000);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
