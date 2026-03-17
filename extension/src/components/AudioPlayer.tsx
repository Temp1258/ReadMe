import { useEffect, useRef, useState } from 'react';
import { listRecordingChunksBySession } from '../db/indexeddb';
import type { TranslationKey } from '../i18n';

type AudioPlayerProps = {
  sessionId: string;
  t: (key: TranslationKey) => string;
};

export function AudioPlayer({ sessionId, t }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBlobUrl(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);

    (async () => {
      try {
        const chunks = await listRecordingChunksBySession(sessionId);
        if (cancelled || chunks.length === 0) {
          setLoading(false);
          return;
        }

        const mimeType = chunks[0].mimeType || 'audio/webm';
        const blob = new Blob(
          chunks.map((c) => c.blob),
          { type: mimeType },
        );
        const url = URL.createObjectURL(blob);

        if (!cancelled) {
          setBlobUrl(url);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load audio');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [blobUrl]);

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      audio.play();
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current && isFinite(audioRef.current.duration)) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  if (loading) {
    return <p className="panel__body" style={{ fontSize: '11px' }}>Loading audio...</p>;
  }

  if (error || !blobUrl) {
    return null;
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0' }}>
      <audio
        ref={audioRef}
        src={blobUrl}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
      />
      <button
        className="button button--secondary button--mini"
        onClick={togglePlayback}
        type="button"
        style={{ minWidth: '60px' }}
      >
        {isPlaying ? t('playbackPause') : t('playbackPlay')}
      </button>
      <span style={{ fontSize: '11px', color: 'var(--muted)', minWidth: '40px' }}>
        {formatTime(currentTime)}
      </span>
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={currentTime}
        onChange={handleSeek}
        style={{ flex: 1, height: '4px' }}
      />
      <span style={{ fontSize: '11px', color: 'var(--muted)', minWidth: '40px' }}>
        {formatTime(duration)}
      </span>
    </div>
  );
}
