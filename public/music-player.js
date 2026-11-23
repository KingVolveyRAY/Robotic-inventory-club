(() => {
  const player = document.querySelector('[data-music-player]');
  if (!player) return;

  const audio = player.querySelector('[data-music-audio]');
  const library = player.querySelector('[data-music-library]');
  const tracks = [...library.options];
  const title = player.querySelector('[data-music-title]');
  const seek = player.querySelector('[data-music-seek]');
  const volume = player.querySelector('[data-music-volume]');
  const elapsed = player.querySelector('[data-music-elapsed]');
  const durationLabel = player.querySelector('[data-music-duration]');
  const message = player.querySelector('[data-music-message]');
  const playButton = player.querySelector('[data-music-play]');
  const playIcon = player.querySelector('[data-music-play-icon]');
  const pauseIcon = player.querySelector('[data-music-pause-icon]');
  const storageKey = 'robolab:music';
  let index = 0;
  let queuedTime = null;
  let lastSaved = 0;
  let leaving = false;

  function storedSettings() {
    try {
      return JSON.parse(sessionStorage.getItem(storageKey)) ?? {};
    } catch {
      return {};
    }
  }

  function saveSettings() {
    if (leaving) return;
    lastSaved = Date.now();
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({
        index, time: queuedTime ?? audio.currentTime, volume: audio.volume,
        playing: !audio.paused && !audio.ended,
      }));
    } catch {
      // The player also works when browser storage is unavailable.
    }
  }

  function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    return minutes + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
  }

  function trackDuration() {
    return queuedTime === null && Number.isFinite(audio.duration)
      ? audio.duration : Number(tracks[index].dataset.duration);
  }

  function showProgress() {
    const duration = trackDuration();
    const time = queuedTime ?? audio.currentTime;
    seek.max = duration;
    seek.value = time;
    elapsed.textContent = formatTime(time);
    durationLabel.textContent = formatTime(duration);
    seek.setAttribute('aria-valuetext', formatTime(time) + ' dari ' + formatTime(duration));
  }

  function showPlayback() {
    const playing = !audio.paused && !audio.ended;
    player.toggleAttribute('data-playing', playing);
    playButton.setAttribute('aria-label', playing ? 'Jeda musik' : 'Putar musik');
    playIcon.hidden = playing;
    pauseIcon.hidden = !playing;
  }

  function showVolume() {
    volume.value = Math.round(audio.volume * 100);
    volume.setAttribute('aria-valuetext', volume.value + ' persen');
  }

  function applySeek() {
    if (queuedTime === null || audio.readyState < 1) return;
    audio.currentTime = Math.min(queuedTime, audio.duration);
    queuedTime = null;
  }

  async function play() {
    message.textContent = '';
    try {
      await audio.play();
    } catch (error) {
      if (error.name === 'AbortError') return;
      message.textContent = error.name === 'NotAllowedError'
        ? 'Tekan Putar untuk melanjutkan musik.'
        : 'Lagu gagal dimuat. Coba putar lagi atau pilih lagu lain.';
      showPlayback();
      saveSettings();
    }
  }

  function selectTrack(next, { time = 0, resume = false } = {}) {
    index = (next + tracks.length) % tracks.length;
    const track = tracks[index];
    const source = track.value;
    library.selectedIndex = index;
    title.textContent = track.textContent;
    message.textContent = '';
    queuedTime = Math.min(time, Number(track.dataset.duration));
    if (audio.getAttribute('src') !== source) audio.setAttribute('src', source);
    else applySeek();
    showProgress();
    if (resume) void play();
    else audio.pause();
    saveSettings();
  }

  function restoreSettings() {
    const settings = storedSettings();
    const next = Number.isInteger(settings.index) && settings.index >= 0 && settings.index < tracks.length
      ? settings.index : 0;
    audio.volume = Number.isFinite(settings.volume) ? Math.min(1, Math.max(0, settings.volume)) : 0.35;
    const time = Number.isFinite(settings.time) && settings.time >= 0 ? settings.time : 0;
    selectTrack(next, { time, resume: settings.playing === true });
    showVolume();
    showPlayback();
  }

  const changeTrack = (next) => selectTrack(next, { resume: !audio.paused });
  player.querySelector('[data-music-previous]').addEventListener('click', () => changeTrack(index - 1));
  player.querySelector('[data-music-next]').addEventListener('click', () => changeTrack(index + 1));
  library.addEventListener('change', () => changeTrack(library.selectedIndex));
  playButton.addEventListener('click', () => {
    if (audio.paused) void play();
    else audio.pause();
  });
  seek.addEventListener('input', () => {
    queuedTime = Number(seek.value);
    applySeek();
    showProgress();
    saveSettings();
  });
  volume.addEventListener('input', () => { audio.volume = Number(volume.value) / 100; });
  audio.addEventListener('loadedmetadata', () => {
    applySeek();
    showProgress();
  });
  audio.addEventListener('timeupdate', () => {
    showProgress();
    if (Date.now() - lastSaved > 1500) saveSettings();
  });
  audio.addEventListener('volumechange', () => {
    showVolume();
    saveSettings();
  });
  for (const event of ['play', 'pause']) {
    audio.addEventListener(event, () => {
      showPlayback();
      saveSettings();
    });
  }
  audio.addEventListener('ended', () => selectTrack(index + 1, { resume: true }));
  audio.addEventListener('error', () => { message.textContent = 'Lagu gagal dimuat. Pilih lagu lain.'; });

  const summary = player.querySelector('summary');
  player.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !player.open) return;
    player.open = false;
    summary.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!player.contains(event.target)) player.open = false;
  });
  window.addEventListener('pagehide', () => {
    saveSettings();
    leaving = true;
    audio.pause();
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    leaving = false;
    restoreSettings();
  });

  restoreSettings();
  audio.hidden = true;
  player.querySelector('[data-music-controls]').hidden = false;
})();
