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

let song_queue = [];
let currently_playing = false;
let current_track_info = null; 
let play_event = false;
let play_task = false;
let ffmpeg_process = null;
let encode_process = null;

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
            '--force-ipv4',                                         // Bypasses broken IPv6 routing to Google Video servers
            '--extractor-args', 'youtube:player_client=android,web', // Spoofs mobile app streams to avoid n-param throttling
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

async function stop_current_ffmpeg({ timeoutMs = 1500 } = {}) {
    const proc = ffmpeg_process;
    if (!proc) return;

    const genAtStop = ++ffmpeg_stop_generation;
    ffmpeg_process = proc;

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
                ffmpeg_process = null;
            }
            resolve();
        };

        proc.once('close', () => finish());
        proc.once('error', () => finish());

        try {
            proc.kill('SIGTERM');
        } catch (e) {}

        setTimeout(() => {
            if (done) return;
            try {
                proc.kill('SIGKILL');
            } catch (e) {}
            finish();
        }, timeoutMs);
    });
}

async function stream_to_radioking(song_file_path, start_seconds = 0, payload = {}) {
    if (!song_file_path || !fs.existsSync(song_file_path)) {
        console.error(`\x1b[31m[FFMPEG ERROR] File path is invalid or does not exist: ${song_file_path}\x1b[0m`);
        return;
    }

    const radio = config.radio || {};
    const icecast_url = `icecast://${radio.username}:${radio.password}@${radio.icecast_server}:${radio.icecast_port}${radio.mount_point}`;

    await ffmpeg_stop_promise;

    return new Promise((resolve) => {
        if (progress_interval) {
            clearInterval(progress_interval);
            progress_interval = null;
        }

        const inputBase = [
            '-re',
            '-analyzeduration', '0',
            '-probesize', '32'
        ];

        const outputLowLatency = [
            '-bufsize', '512k',
            '-flush_packets', '1'
        ];

        const mode = payload && payload.mode ? payload.mode : (start_seconds === 0 ? 'copy' : 'reencode');
        let args;

        if (mode === 'copy') {
            args = [
                '-re',
                '-i', song_file_path,
                '-acodec', 'libmp3lame',
                '-b:a', '128k',
                '-ar', '44100',
                '-ac', '2',
                '-f', 'mp3',
                '-content_type', 'audio/mpeg',
                '-bufsize', '512k',
                '-flush_packets', '1',
                icecast_url
            ];
        } else {
            args = [
                ...inputBase,
                '-ss', start_seconds.toString(),
                '-i', song_file_path,
                '-acodec', 'libmp3lame',
                '-ab', '128k',
                '-ar', '44100',
                '-ac', '2',
                '-f', 'mp3',
                '-content_type', 'audio/mpeg',
                ...outputLowLatency,
                '-flush_packets', '1',
                icecast_url
            ];
        }

        const env = { ...process.env };
        ffmpeg_process = spawn('ffmpeg', args, { env });

        ffmpeg_process.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (!msg) return;
            console.log(`[FFMPEG] ${msg}`);
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

        ffmpeg_process.on('close', () => {
            clearInterval(progress_interval);
            resolve();
        });
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

    if (encode_process) {
        try { encode_process.kill(); } catch (e) {}
    }

    currently_playing = false;
    current_track_info = null;
    play_event = false;
    play_task = false;
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
    logWithTime(chalk.green, `\n[Music Bot Ready] Connected successfully!`);
    logWithTime(chalk.cyan, `Logged in as Bot ID: ${session.user_id}`);
    
    const posPath = path.join(__dirname, 'musicbot_pos.json');
    if (fs.existsSync(posPath)) {
        try {
            const posData = JSON.parse(fs.readFileSync(posPath, 'utf8'));
            const cleanStr = posData.bot_position.replace('}', '');
            const parts = cleanStr.split(',').reduce((acc, part) => {
                const [key, val] = part.split('=');
                if (key && val) {
                    acc[key.trim()] = val.trim().replace(/['"]/g, '');
                }
                return acc;
            }, {});

            setTimeout(async () => {
                try {
                    let facingDirection = parts.facing;
                    if (facingDirection.toLowerCase() === 'frontright') facingDirection = 'FrontRight';
                    if (facingDirection.toLowerCase() === 'frontleft') facingDirection = 'FrontLeft';
                    if (facingDirection.toLowerCase() === 'backright') facingDirection = 'BackRight';
                    if (facingDirection.toLowerCase() === 'backleft') facingDirection = 'BackLeft';

                    await bot.player.teleport(
                        session.user_id, 
                        parseFloat(parts.x), 
                        parseFloat(parts.y), 
                        parseFloat(parts.z), 
                        facingDirection
                    );
                    logWithTime(chalk.green, `[TELEPORT SUCCESS] Bot successfully moved to: x=${parts.x}, y=${parts.y}, z=${parts.z}, facing=${facingDirection}`);
                    await bot.message.send(`[System] BeatlY On The Beat!`);
                } catch (teleportErr) {
                    console.error(chalk.red("[TELEPORT DELAYED ERROR] Failed inside timeout:"), teleportErr.message);
                }
            }, 2000);

        } catch (e) {
            console.error(chalk.red("[TELEPORT ERROR] Failed to parse musicbot_pos.json, using default fallback:"), e);
            await bot.player.teleport(session.user_id, 0, 0, 0);
        }
    } else {
        await bot.player.teleport(session.user_id, 0, 0, 0);
    }
    await fetch_autoplay_playlist();

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

        if (encode_process) {
            try { encode_process.kill(); } catch (e) {}
        }

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
});

bot.on('error', (error) => {
    console.error(chalk.red(`[Highrise Error]:`), error);
});

bot.login(config.token, config.room_id);
