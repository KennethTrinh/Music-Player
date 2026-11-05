import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const musicDir = path.join(__dirname, '..', 'music');
const outputFile = path.join(musicDir, 'index.json');

const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|flac|aac|m4a)$/i;

const songs = fs.readdirSync(musicDir)
    .filter(f => AUDIO_EXTENSIONS.test(f))
    .map(f => ({
        name: f.replace(/\.[^/.]+$/, ''),
        path: `music/${f}`
    }));

fs.writeFileSync(outputFile, JSON.stringify(songs, null, 2));
console.log(`Generated music/index.json with ${songs.length} song(s)`);
