const { Highrise, GatewayIntentBits } = require("highrise.sdk");
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { spawn } = require('child_process');
require("colors");

const settings = {
    events: ['ready', 'playerJoin', 'playerLeave', 'messages'],
    reconnect: 1
};

const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
    console.error(chalk.red("[ERROR] Configuration file (config.json) not found!"));
    process.exit(1);
}
const config = require(configPath);

const bot = new Highrise({
    intents: [
        GatewayIntentBits.Ready,
        GatewayIntentBits.Messages,
        GatewayIntentBits.Joins,
        GatewayIntentBits.Leaves,
        GatewayIntentBits.Error
    ],
    cache: true,
    AutoFetchMessages: true
}, settings.reconnect);

function logWithTime(colorFn, message) {
    const now = new Date();
    const timeStr = `[${now.toLocaleTimeString()}.${String(now.getMilliseconds()).padStart(3, '0')}]`;
    console.log(colorFn(`${timeStr} ${message}`));
}

const downloadsFolder = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsFolder)) {
    fs.mkdirSync(downloadsFolder, { recursive: true });
}


let botPosition = null;
let botUserId = null;
let encode_process = null;
let song_queue = [];
let currently_playing = false;
let current_track_info = null; 
let play_event = false;
let play_task = false;
let master_ffmpeg = null;
let decoder_process = null; // ده بديل لـ ffmpeg_process للأغاني
let silence_process = null; // ده لإنتاج الصوت الصامت في الفواصلlet encode_process = null;

let ffmpeg_stop_generation = 0;
let ffmpeg_stop_promise = Promise.resolve();
let progress_interval = null;
let start_time_ms = 0;
let elapsed_paused_seconds = 0; 

let autoplay_tracks_raw = []; 
let autoplay_pool = [];       
let is_autoplay_active = false; 
let autoplay_timeout_handler = null; 
let is_searching = false;           

let playback_generation = 0;

const queue_file = path.join(__dirname, 'song_queue.json');
const current_song_file = path.join(__dirname, 'current_song.json');

try { song_queue = JSON.parse(fs.readFileSync(queue_file, 'utf8')); } catch(e) { song_queue = []; }

function save_queue() {
    fs.writeFileSync(queue_file, JSON.stringify(song_queue, null, 4));
}

function format_time(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

// 1. البث الرئيسي (دلوقتي بياخد MP3 جاهز وبيرفعه مباشرة بدون ضغط من أول وجديد)
function start_master_stream() {
    if (master_ffmpeg) return;
    
    const radio = config.radio || {};
    const icecast_url = `icecast://source:${radio.password}@${radio.icecast_server}:${radio.icecast_port}${radio.mount_point}`;
    
    logWithTime(chalk.blue, "[STREAM] Starting stable stream...");
    
    // شلنا كل الـ Ice-specific params وسيبنا الأساسيات بس
    master_ffmpeg = spawn('ffmpeg', [
        '-re',
        '-f', 'mp3',
        '-i', 'pipe:0',
        '-c:a', 'copy',
        '-content_type', 'audio/mpeg',
        '-f', 'mp3',
        icecast_url
    ]);

    master_ffmpeg.on('error', (err) => {
        logWithTime(chalk.red, `[STREAM] FFMPEG Error: ${err.message}`);
    });

    master_ffmpeg.on('close', (code) => {
        logWithTime(chalk.red, `[STREAM] FFMPEG Closed (Code: ${code}). Retrying in 10s...`);
        master_ffmpeg = null;
        // زودنا الوقت لـ 10 ثواني عشان السيرفر يلحق يفتح الكونكشن صح
        setTimeout(start_master_stream, 10000); 
    });
}

// 2. الصمت (بيصنع MP3 صامت ويبعته)
function start_silence() {
    if (silence_process) return;
    
    silence_process = spawn('ffmpeg', [
        '-re',
        '-f', 'lavfi',
        '-i', 'anullsrc=r=44100:cl=stereo',
        '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-ac', '2',
        '-f', 'mp3',
        'pipe:1'
    ]);
    
    silence_process.stdout.on('data', (chunk) => {
        if (master_ffmpeg && master_ffmpeg.stdin && master_ffmpeg.stdin.writable) {
            master_ffmpeg.stdin.write(chunk);
        }
    });
}

// 3. دي زي ما هي مفيهاش تعديل بس عشان تتأكد إنها معاك
function stop_silence() {
    if (silence_process) {
        silence_process.stdout.removeAllListeners('data');
        try { silence_process.kill('SIGKILL'); } catch(e){}
        silence_process = null;
    }
}

async function fetch_autoplay_playlist() {
    if (!config.autoplay_list) {
        logWithTime(chalk.red, "[AUTOPLAY] No autoplay_list link found in config.json");
        return;
    }
    logWithTime(chalk.blue, `[AUTOPLAY] Fetching tracks from playlist metadata...`);
    
    return new Promise((resolve) => {
        const args = ['--flat-playlist', '--dump-json', config.autoplay_list];
        const env = { ...process.env };
        
        const ytPlaylist = spawn('yt-dlp', args, { env });
        let outputStr = "";
        
        ytPlaylist.stdout.on('data', (data) => { outputStr += data.toString(); });
        ytPlaylist.on('close', () => {
            const lines = outputStr.split('\n');
            autoplay_tracks_raw = [];
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.title && parsed.url) {
                        autoplay_tracks_raw.push({
                            title: parsed.title,
                            url: parsed.url,
                            duration: parsed.duration || 180
                        });
                    }
                } catch(e) {}
            }
            logWithTime(chalk.green, `[AUTOPLAY] Successfully loaded ${autoplay_tracks_raw.length} tracks into the pool configuration!`);
            resolve();
        });
    });
}

// 🚀 سحب الصوت الخام وتعديل نظام الحماية لملفات الـ Preload
async function fetch_and_download_youtube(song_url, fallback_title = "Unknown", fallback_duration = 180) {
    return new Promise((resolve) => {
        // تنظيف فولدر التحميلات القديمة مع حماية الأغنية الشغالة والأغاني الجاهزة في الكييو
        const oldFiles = fs.readdirSync(downloadsFolder);
        for (const file of oldFiles) { 
            try { 
                const filePath = path.join(downloadsFolder, file);
                if (current_track_info && current_track_info.file_path === filePath) continue;
                
                // تحديث: حماية أي ملف تم تحميله مسبقاً وموجود في الطابور حالياً
                const isPreloaded = song_queue.some(s => s.file_path === filePath);
                if (isPreloaded) continue;

                fs.unlinkSync(filePath); 
            } catch(e){} 
        }

        const uniqueId = Date.now();
        const outputTemplate = path.join(downloadsFolder, `${uniqueId}_%(id)s.%(ext)s`);
        
        const downloadArgs = [
            '--cookies', path.join(__dirname, 'cookies.txt'), 
            '--format', 'bestaudio/best',
            '--no-playlist',
            '--extractor-args', 'youtube:player_client=web', // 👈 إضافة دي لتهريب الطلب من الحظر
            '--force-overwrites', // 👈 للتأكد إن الملفات مابتعملش تداخل
            '--output', outputTemplate, 
                    song_url
        ];
        
        const env = { ...process.env };
        const ytDownloader = spawn('yt-dlp', downloadArgs, { env });

        ytDownloader.stderr.on('data', (data) => {
            console.error(`\x1b[31m[yt-dlp Download Error]: ${data.toString()}\x1b[0m`);
        });

        ytDownloader.stdout.on('data', (data) => {
            console.log(`[yt-dlp Download Log]: ${data.toString().trim()}`);
        });
        
        ytDownloader.on('close', (code) => {
            console.log(`[yt-dlp] Process exited with code: ${code}`);
            const files = fs.readdirSync(downloadsFolder).filter(f => f.startsWith(`${uniqueId}_`));
            
            if (files.length > 0) {
                resolve({
                    file_path: path.join(downloadsFolder, files[0]),
                    real_title: fallback_title,
                    real_duration: fallback_duration
                });
            } else {
                console.error(`\x1b[31m[Error] Failed to find the downloaded file for ID: ${uniqueId}\x1b[0m`);
                resolve({ file_path: null, real_title: fallback_title, real_duration: fallback_duration });
            }
        });
    });
}

// 🌐 فانكشن جديدة للتحميل المسبق للأغنية التالية في الطابور في الخلفية
async function preload_next_song() {
    if (song_queue.length === 0) return;
    
    const next_song = song_queue[0]; // جلب أول أغنية منتظرة في الكييو
    
    // لو متنزلة فعلاً أو جاري تحميلها حالياً، اخرج
    if (next_song.file_path || next_song.is_downloading) return;

    next_song.is_downloading = true;
    logWithTime(chalk.yellow, `[PRELOAD] Background downloading started for next song: "${next_song.title}"...`);

    const result = await fetch_and_download_youtube(next_song.url, next_song.title, next_song.duration);

    if (result.file_path) {
        next_song.file_path = result.file_path;
        logWithTime(chalk.green, `[PRELOAD] Next song is fully buffered and ready to play instantly: "${next_song.title}"`);
    } else {
        logWithTime(chalk.red, `[PRELOAD] Failed to pre-download: "${next_song.title}"`);
    }
    next_song.is_downloading = false;
}


async function stream_to_radioking(song_file_path, start_seconds = 0, payload = {}) {
    if (!master_ffmpeg) start_master_stream();

    return new Promise((resolve) => {
        stop_silence(); // بنوقف الصمت أولاً

        if (progress_interval) {
            clearInterval(progress_interval);
            progress_interval = null;
        }

        // أوامر التجهيز لمنع اللجلجة في التقديم
        let args = [
            '-re',
            '-analyzeduration', '0', 
            '-probesize', '32'
        ];
        
        if (start_seconds > 0) {
            args.push('-ss', start_seconds.toString());
        }

        // تحويل الأغنية لـ MP3 وإرسالها للماستر
        args.push(
            '-i', song_file_path,
            '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-ac', '2',
            '-f', 'mp3',
            'pipe:1'
        );

        const env = { ...process.env };
        decoder_process = spawn('ffmpeg', args, { env });

        decoder_process.stdout.on('data', (chunk) => {
            if (master_ffmpeg && master_ffmpeg.stdin && master_ffmpeg.stdin.writable) {
                master_ffmpeg.stdin.write(chunk);
            }
        });

        start_time_ms = Date.now();
        elapsed_paused_seconds = start_seconds;

        progress_interval = setInterval(() => {
            const current_elapsed = elapsed_paused_seconds + Math.floor((Date.now() - start_time_ms) / 1000);
            if (current_track_info) {
                current_track_info.elapsed = current_elapsed;
                if (!is_autoplay_active) {
                    fs.writeFileSync(current_song_file, JSON.stringify(current_track_info, null, 4));
                }
            }
        }, 1500);

        decoder_process.on('close', () => {
            clearInterval(progress_interval);
            decoder_process = null;
            start_silence(); 
            resolve();
        });
    });
}

async function stop_current_ffmpeg({ timeoutMs = 1500 } = {}) {
    const proc = decoder_process;
    if (!proc) return;

    const genAtStop = ++ffmpeg_stop_generation;
    decoder_process = proc;

    if (progress_interval) {
        clearInterval(progress_interval);
        progress_interval = null;
    }

    await new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            try {
                proc.removeAllListeners('close');
                proc.removeAllListeners('error');
            } catch (e) {}
            if (ffmpeg_stop_generation === genAtStop) {
                decoder_process = null;
                start_silence(); // لو عملنا سكيب، شغل الصمت لحد ما الأغنية الجديدة تبدأ
            }
            resolve();
        };

        proc.once('close', () => finish());
        proc.once('error', () => finish());

        try { proc.kill('SIGTERM'); } catch (e) {}

        setTimeout(() => {
            if (done) return;
            try { proc.kill('SIGKILL'); } catch (e) {}
            finish();
        }, timeoutMs);
    });
}

async function check_and_start_autoplay_timer() {
    if (autoplay_timeout_handler) {
        clearTimeout(autoplay_timeout_handler);
        autoplay_timeout_handler = null;
    }

    if (autoplay_tracks_raw.length === 0) return;
    if (play_task || currently_playing || song_queue.length > 0 || is_searching) return;

    const timer_generation = playback_generation;
    const wait_seconds = config.autoplay_timer !== undefined ? parseInt(config.autoplay_timer) : 60;
    logWithTime(chalk.magenta, `[AUTOPLAY] Queue is empty. Timer armed! Will launch Autoplay in ${wait_seconds} seconds...`);
    try {
        await bot.message.send(`📻 [AUTOPLAY] Queue is empty. Timer armed! Will launch Autoplay in ${wait_seconds} seconds...`);
    } catch (err) {
        console.error("Failed to send autoplay timer message:", err);
    }

    autoplay_timeout_handler = setTimeout(() => {
        if (timer_generation !== playback_generation) return;
        if (is_searching) return;
        if (song_queue.length !== 0) return;
        if (currently_playing || play_task) return;

        play_event = true;
        play_task = true;
        is_autoplay_active = true;
        logWithTime(chalk.green, `[AUTOPLAY] Timer expired. Booting Auto-Play engine now...`);
        bot.message.send(`📻 [AUTOPLAY] Timer expired. Booting Auto-Play engine now...`);
        playback_loop();
    }, wait_seconds * 1000);
}

function interrupt_autoplay() {
    playback_generation++;

    if (autoplay_timeout_handler) {
        clearTimeout(autoplay_timeout_handler);
        autoplay_timeout_handler = null;
    }

    is_autoplay_active = false;
    clearInterval(progress_interval);

    ffmpeg_stop_promise = stop_current_ffmpeg({ timeoutMs: 2000 });

    

    currently_playing = false;
    current_track_info = null;
    play_event = false;
    play_task = false;
}

function saveBotPosition() {
    const locData = {
        bot_position: botPosition ? { x: botPosition.x, y: botPosition.y, z: botPosition.z, facing: botPosition.facing } : null,
        admins: [config.owner]
    };
    const filePath = path.join(__dirname, 'musicbot_pos.json');
    try {
        fs.writeFileSync(filePath, JSON.stringify(locData, null, 2), { encoding: 'UTF-8' });
        console.log(chalk.green("[INFO] Bot position saved successfully."));
    } catch (error) {
        console.error(chalk.red(`[ERROR] Failed to save bot position: ${error.message}`));
    }
}

// تحميل موقع البوت من ملف .json
function loadBotPosition() {
    const filePath = path.join(__dirname, 'musicbot_pos.json');
    try {
        if (!fs.existsSync(filePath)) {
            console.log(chalk.yellow("[INFO] No saved bot position found. Starting at default position."));
            return false;
        }

        const locData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const pos = locData.bot_position;
        if (pos && pos.x !== undefined && pos.y !== undefined && pos.z !== undefined && pos.facing !== undefined) {
            botPosition = pos;
            console.log(chalk.green("[INFO] Bot position loaded successfully."));
            return true;
        }
    } catch (err) {
        console.error(chalk.red(`[ERROR] Failed to load bot position: ${err.message}`));
    }
    return false;
}

async function playback_loop() {
    play_event = true;

    while (play_event) {
        if (song_queue.length === 0) {
            if (is_autoplay_active && autoplay_tracks_raw.length > 0) {
                if (autoplay_pool.length === 0) autoplay_pool = [...autoplay_tracks_raw];
                const random_index = Math.floor(Math.random() * autoplay_pool.length);
                const chosen_track = autoplay_pool.splice(random_index, 1)[0];

                currently_playing = true;
                const result = await fetch_and_download_youtube(chosen_track.url, chosen_track.title, chosen_track.duration);
                
                if (!is_autoplay_active) {
                    if (result.file_path && fs.existsSync(result.file_path)) fs.unlinkSync(result.file_path);
                    continue;
                }

                if (!result.file_path) {
                    logWithTime(chalk.red, `[AUTOPLAY] Failed to download track: ${chosen_track.title}. Skipping...`);
                    currently_playing = false;
                    continue;
                }

                current_track_info = { title: result.real_title, owner: "AutoPlay_System", duration: result.real_duration, file_path: result.file_path, elapsed: 0 };
                await bot.message.send(`📻 [Auto-Play] Now Playing: "${current_track_info.title}"`);
                
                // تجهيز الأغنية التالية لو حد ضاف حاجة فجأة في الكييو
                preload_next_song();

                await stream_to_radioking(result.file_path, 0, { mode: 'copy' });
                
                if (fs.existsSync(result.file_path)) fs.unlinkSync(result.file_path);
            } else {
                break;
            }
        } 
        else {
            is_autoplay_active = false;
            const next_song = song_queue.shift();
            save_queue();
            
            currently_playing = true;
            
            let result = null;

            // إذا تم تحميل الأغنية مسبقاً، نأخذ ملفها مباشرة بدون تكرار التحميل
            if (next_song.file_path && fs.existsSync(next_song.file_path)) {
                logWithTime(chalk.green, `[PLAYBACK] Instantly launching preloaded track: "${next_song.title}"`);
                result = {
                    file_path: next_song.file_path,
                    real_title: next_song.title,
                    real_duration: next_song.duration
                };
            } else {
                // لو كانت لسه بتتحمل في الخلفية وخلصت الأغنية القديمة بسرعة، ننتظرها تخلص تحميل
                if (next_song.is_downloading) {
                    logWithTime(chalk.yellow, `[PLAYBACK] Next song is finishing its preload cache, holding for a few moments...`);
                    while (next_song.is_downloading) {
                        await new Promise(r => setTimeout(r, 300));
                    }
                    if (next_song.file_path && fs.existsSync(next_song.file_path)) {
                        result = {
                            file_path: next_song.file_path,
                            real_title: next_song.title,
                            real_duration: next_song.duration
                        };
                    }
                }
                
                // حماية أخيرة: لو منزلتش خالص، حملها عادي بالطريقة العادية
                if (!result) {
                    result = await fetch_and_download_youtube(next_song.url, next_song.title, next_song.duration);
                }
            }

            if (!result.file_path) {
                await bot.message.send(`❌ Failed to download: "${next_song.title}". Skipping to next...`);
                currently_playing = false;
                continue;
            }

            current_track_info = { title: result.real_title, owner: next_song.owner, duration: result.real_duration, file_path: result.file_path, elapsed: 0 };
            
            fs.writeFileSync(current_song_file, JSON.stringify(current_track_info, null, 4));

            await bot.message.send(`🎵 Now Playing: \n"${current_track_info.title}" \nRequested by @${current_track_info.owner}`);
            
            // 🔥 أهم خطوة: بدأنا تشغيل الأغنية الحالية؟ فوراً نبدأ نحمل الأغنية اللي بعدها في الخلفية
            preload_next_song();

            await stream_to_radioking(result.file_path, 0, { mode: 'copy' });

            if (fs.existsSync(current_song_file)) { try { fs.unlinkSync(current_song_file); } catch(e){} }
            if (result.file_path && fs.existsSync(result.file_path)) fs.unlinkSync(result.file_path);
        }

        currently_playing = false;
        current_track_info = null;
    }
    
    play_event = false;
    play_task = false;
    currently_playing = false;
    current_track_info = null;
    check_and_start_autoplay_timer();
}

bot.on('ready', async (session) => {
    botUserId = session.user_id;
    logWithTime(chalk.green, `\n[Music Bot Ready] Connected successfully!`);
    logWithTime(chalk.cyan, `Logged in as Bot ID: ${session.user_id}`);
    const positionLoaded = loadBotPosition();
    if (positionLoaded) {
        await bot.player.teleport(session.user_id, botPosition.x, botPosition.y, botPosition.z, botPosition.facing);
        await bot.message.send("Made By BeatlY\n join us at:\nwwww.beatly.click");
    } else {
        // إذا لم يجد موقع مخزن يبدأ من نقطة الصفر
        await bot.player.teleport(session.user_id, 0, 0, 0);
        await bot.message.send("Made By BeatlY\n join us at:\nwwww.beatly.click");
    }
    await fetch_autoplay_playlist();
    start_master_stream();

    if (fs.existsSync(current_song_file)) {
        try {
            const saved_track = JSON.parse(fs.readFileSync(current_song_file, 'utf8'));
            if (saved_track && saved_track.file_path && fs.existsSync(saved_track.file_path)) {
                logWithTime(chalk.yellow, `[RECOVERY] Found interrupted track: "${saved_track.title}" at second ${saved_track.elapsed}`);
                const minutesStr = format_time(saved_track.elapsed);
                
                await bot.message.send(`⚠️ Reconnected now... \n🔄 Resuming track: \n"${saved_track.title}" \nStarting from: [${minutesStr}]⏱️ \n👤 Requested by: @${saved_track.owner}`);
                currently_playing = true;
                current_track_info = saved_track;
                play_event = true;
                play_task = true;
                is_autoplay_active = false;

                (async () => {
                    await stream_to_radioking(saved_track.file_path, saved_track.elapsed, { mode: 'reencode' });
                    if (fs.existsSync(current_song_file)) { try { fs.unlinkSync(current_song_file); } catch(e){} }
                    if (fs.existsSync(saved_track.file_path)) { try { fs.unlinkSync(saved_track.file_path); } catch(e){} }
                    currently_playing = false;
                    current_track_info = null;
                    playback_loop();
                })();
                return;
            }
        } catch (e) {
            console.error(chalk.red("[RECOVERY ERROR] Cannot parse current_song.json"), e);
        }
    }

    if (song_queue.length > 0 && !play_task) {
        play_event = true;
        play_task = true;
        playback_loop();
    } else {
        check_and_start_autoplay_timer();
    }
});

bot.on('chatCreate', async (user, message) => {
    logWithTime(chalk.yellow, `[CHAT] @${user.username}: ${message}`);
    const lowerMessage = message.toLowerCase().trim();

    if (lowerMessage.startsWith("/play ") || lowerMessage.startsWith("/p ")) {
        const offset = lowerMessage.startsWith("/play ") ? 6 : 3;
        const songQuery = message.substring(offset).trim();

        if (!songQuery) return;

        playback_generation++; 
        is_searching = true;
        
        if (is_autoplay_active === true) {
            logWithTime(chalk.yellow, `[AUTOPLAY] Interrupting autoplay to prioritize @${user.username}`);
            await bot.message.send(`⚠️ Interrupting autoplay to prioritize @${user.username}`);
            interrupt_autoplay();
        }

        await bot.whisper.send(user.id,`🔍 Searching for @${user.username}... \n[ ${songQuery} ]`);

        const metaArgs = ['--cookies', path.join(__dirname, 'cookies.txt'), '--dump-json', `ytsearch1:${songQuery}`];
        const env = { ...process.env };

        let metaDataStr = '';
        const ytMeta = spawn('yt-dlp', metaArgs, { env });
        
        ytMeta.stdout.on('data', (data) => { metaDataStr += data.toString(); });
        ytMeta.on('close', async () => {
            let finalTitle = songQuery;
            let finalDuration = 180;
            let videoUrl = `ytsearch1:${songQuery}`;

            try {
                const parsed = JSON.parse(metaDataStr);
                finalTitle = parsed.title || finalTitle;
                finalDuration = parsed.duration || finalDuration;
                if (parsed.webpage_url) {
                    videoUrl = parsed.webpage_url;
                } else if (parsed.id) {
                    videoUrl = `https://www.youtube.com/watch?v=${parsed.id}`;
                }
            } catch (e) {}

            const song = { title: finalTitle, owner: user.username, duration: finalDuration, url: videoUrl };
            song_queue.push(song);
            save_queue();
            is_searching = false;

            await bot.message.send(`✅ Found! Title: \n"${finalTitle}"\n⏱️ Duration: [${format_time(finalDuration)}]\n🔢 Queue Position: #${song_queue.length}\n👤 Requested by: @${user.username}`);

            // تشغيل التحميل المسبق فوراً إذا أصبحت الأغنية هي التالية في الانتظار
            preload_next_song();

            play_event = true;
            if (!play_task) {
                play_task = true;
                playback_loop();
            }
        });
    }
    
    else if (lowerMessage === "/q" || lowerMessage === "/queue") {
        if (song_queue.length === 0) {
            await bot.message.send("The music queue is currently empty.");
            return;
        }
        
        let queue_message = `Current Queue (${song_queue.length} songs):\n\n`;
        song_queue.slice(0, 5).forEach((song, idx) => {
            const cleanTitle = song.title.length > 35 ? song.title.substring(0, 35) + "..." : song.title;
            queue_message += `${idx + 1} - 🔽\n"${cleanTitle}"\n👤 Req by: @${song.owner}\n\n`;
        });
        
        if (song_queue.length > 5) {
            queue_message += `... and ${song_queue.length - 5} more tracks.`;
        }
        
        await bot.whisper.send(user.id,queue_message);
    }

    else if (lowerMessage === "/np") {
        if (!currently_playing || !current_track_info) {
            await bot.message.send("No song is currently playing right now.");
            return;
        }

        const current_elapsed = elapsed_paused_seconds + Math.floor((Date.now() - start_time_ms) / 1000);
        const total_duration = current_track_info.duration;
        
        const bar_total_elements = 15;
        const progress_ratio = Math.min(current_elapsed / total_duration, 1);
        const current_ball_position = Math.round(progress_ratio * bar_total_elements);

        let progress_bar = "";
        for (let i = 0; i <= bar_total_elements; i++) {
            if (i === current_ball_position) { progress_bar += "●"; } else { progress_bar += "➖"; }
        }

        const display_owner = is_autoplay_active ? "System (Auto-Play)" : `@${current_track_info.owner}`;
        await bot.whisper.send(user.id,`🎵 Now Playing: \n"${current_track_info.title}"\n${progress_bar}\n⏱️ Time: [${format_time(current_elapsed)} / ${format_time(total_duration)}]\n👤 Requested by: ${display_owner}`);
    }
    
    else if (lowerMessage === "/skip") {
        if (!currently_playing || !current_track_info) {
            await bot.message.send("There is no song playing to skip.");
            return;
        }
        
        const display_owner = is_autoplay_active ? "System (Auto-Play)" : `@${current_track_info.owner}`;
        await bot.message.send(`⏭️ Skipped: \n"${current_track_info.title}"\n👤 Skipped by: @${user.username}\n📥 Originally requested by: ${display_owner}`);
        
        clearInterval(progress_interval);
        ffmpeg_stop_promise = stop_current_ffmpeg({ timeoutMs: 1500 });

        

        if (fs.existsSync(current_song_file)) { try { fs.unlinkSync(current_song_file); } catch(e){} }
        
        currently_playing = false;
        current_track_info = null;
        playback_generation++;
    }

    else if (lowerMessage === "/clearq") {
        if (user.username.toLowerCase() === config.owner.toLowerCase()) {
            // مسح ملفات الـ Cache للأغاني المحملة مسبقاً لحفظ مساحة الهارد
            for (const song of song_queue) {
                if (song.file_path && fs.existsSync(song.file_path)) {
                    try { fs.unlinkSync(song.file_path); } catch(e){}
                }
            }
            song_queue = [];
            save_queue();
            await bot.message.send("Music queue has been cleared completely.");
            if (!currently_playing) check_and_start_autoplay_timer();
        } else {
            await bot.message.send("Only the bot owner can clear the queue.");
        }
    }
    
    else if (lowerMessage === "/del") {
        let idx = song_queue.findIndex(s => s.owner === user.username);
        if (idx !== -1) {
            const removed = song_queue.splice(idx, 1)[0];
            // مسح ملف الأغنية المحمية لو اتنزلت قبل الحذف
            if (removed.file_path && fs.existsSync(removed.file_path)) {
                try { fs.unlinkSync(removed.file_path); } catch(e){}
            }
            save_queue();
            await bot.message.send(`Removed your song: "${removed.title}" from the queue.`);
            
            // إعادة تحميل الأغنية التي أصبحت الأولى بعد عملية الحذف
            preload_next_song();
            
            if (song_queue.length === 0 && !currently_playing) check_and_start_autoplay_timer();
        } else {
            await bot.message.send("You don't have any songs in the queue to remove.");
        }
    }
    if (user.username === config.owner || config.admins.includes(user.username)) {
        
        // أمر وضع الموقع الجديد
        if (message.startsWith("!setpos")) {
            console.log(`[DEBUG] Attempting to retrieve position for user ID: ${user.id}`);
    
            try {
                // جلب قائمة اللاعبين المتواجدين في الغرفة من الكاش
                const players = await bot.room.players.cache.get();
    
                // البحث عن إحداثيات الشخص اللي كتب الأمر
                const playerEntry = players.find(p => p[0].id === user.id);
    
                if (!playerEntry) {
                    console.error(`[ERROR] Failed to retrieve position for user ID: ${user.id}`);
                    await bot.message.send("Failed to retrieve your position. Please move around and try again.");
                    return;
                }
    
                // استخراج الإحداثيات (المصفوفة تحتوي على بيانات اللاعب في خانة 0 والموقع في خانة 1)
                const position = playerEntry[1];
        
                // حفظ الإحداثيات الجديدة في المتغير وفي الملف
                botPosition = position;
                saveBotPosition();
    
                await bot.message.send("Bot position set! Refreshing...");
    
                // انتظار ثانيتين قبل عمل الريفرش
                await new Promise(resolve => setTimeout(resolve, 2000));
    
                // التأكد أن الـ ID الخاص بالبوت مسجل لتفادي توقف السكريبت
                if (!botUserId) {
                    console.error("[ERROR] Bot user ID is not set. Unable to teleport.");
                    await bot.message.send("Error: Could not teleport bot. Please restart the bot and try again.");
                    return;
                }
    
                // عمل نقل (Teleport) الفوري للبوت للمكان الجديد المختار
                await bot.player.teleport(botUserId, botPosition.x, botPosition.y, botPosition.z, botPosition.facing);
    
                await bot.message.send("Bot has been refreshed to the new position!");
    
            } catch (error) {
                console.error(`[ERROR] Error fetching player data: ${error.message}`);
                await bot.message.send("An error occurred while retrieving your position.");
            }
        }
    }
});

bot.on('error', (error) => {
    console.error(chalk.red(`[Highrise Error]:`), error);
});

bot.login(config.token, config.room_id);
