'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import { planEditingSteps, describePlan, clampAudioTempoChain, type AgentPlan, type Operation } from '@/lib/agent';

const SUPPORTED_INPUT_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/ogg'];

const defaultPrompt =
  'Trim the first 5 seconds, convert to black and white, speed up to 1.2x, and mute the audio.';

export const VideoAgent = () => {
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [isReady, setIsReady] = useState(false);
  const [isLoadingCore, setIsLoadingCore] = useState(false);
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [agentPlan, setAgentPlan] = useState<AgentPlan | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [outputFileName, setOutputFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      if (outputUrl) URL.revokeObjectURL(outputUrl);
    };
  }, [sourceUrl, outputUrl]);

  const loadFfmpeg = useCallback(async () => {
    if (isReady || isLoadingCore) return;
    setIsLoadingCore(true);
    try {
      const instance = new FFmpeg();
      ffmpegRef.current = instance;
      await instance.load();
      instance.on('progress', ({ progress }) => {
        setProgress(Math.min(99, Math.round(progress * 100)));
      });
      setIsReady(true);
    } catch (err) {
      setError('Failed to load FFmpeg. Please reload the page.');
      console.error(err);
    } finally {
      setIsLoadingCore(false);
    }
  }, [isReady, isLoadingCore]);

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setError(null);
      const file = event.target.files?.[0];
      if (!file) return;
      if (!SUPPORTED_INPUT_TYPES.includes(file.type)) {
        setError('Unsupported file type. Please use MP4, MOV, WEBM, or OGG.');
        return;
      }
      setSourceFile(file);
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      const nextUrl = URL.createObjectURL(file);
      setSourceUrl(nextUrl);
      setOutputUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setAgentPlan(null);
    },
    [sourceUrl],
  );

  const handlePlan = useCallback(() => {
    setError(null);
    if (!prompt.trim()) {
      setError('Describe the edit you want to make.');
      return;
    }
    const plan = planEditingSteps(prompt);
    setAgentPlan(plan);
  }, [prompt]);

  const processVideo = useCallback(async () => {
    setError(null);
    if (!sourceFile) {
      setError('Upload a video before running edits.');
      return;
    }
    if (!agentPlan) {
      handlePlan();
    }
    const plan = agentPlan ?? planEditingSteps(prompt);
    setAgentPlan(plan);

    try {
      await loadFfmpeg();
      if (!ffmpegRef.current) {
        throw new Error('FFmpeg failed to initialise');
      }
      setIsProcessing(true);
      setProgress(0);

      const ffmpeg = ffmpegRef.current;
      const inputName = `input${getExtension(sourceFile.name)}`;
      const outputName = `output.${plan.outputExtension}`;

      await safeDelete(ffmpeg, inputName);
      await safeDelete(ffmpeg, outputName);

      await ffmpeg.writeFile(inputName, await fetchFile(sourceFile));
      const args = buildFfmpegArgs(plan.operations, plan.outputExtension, inputName, outputName);
      await ffmpeg.exec(args);

      const data = await ffmpeg.readFile(outputName);
      const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const blob = new Blob([buffer as unknown as BlobPart], {
        type: plan.outputExtension === 'gif' ? 'image/gif' : 'video/mp4',
      });
      const url = URL.createObjectURL(blob);
      setOutputUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      setOutputFileName(`agentic-${Date.now()}.${plan.outputExtension}`);
      setProgress(100);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to process the video.');
    } finally {
      setIsProcessing(false);
    }
  }, [agentPlan, handlePlan, loadFfmpeg, prompt, sourceFile]);

  const planSummary = useMemo(() => (agentPlan ? describePlan(agentPlan) : []), [agentPlan]);

  return (
    <section className="mx-auto w-full max-w-5xl space-y-10 px-4 py-12">
      <header className="space-y-3 text-center md:text-left">
        <p className="text-sm font-semibold uppercase tracking-widest text-sky-500">
          Agentic Video Editor
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-900">
          AI-guided edits for your video in the browser
        </h1>
        <p className="text-base text-zinc-600 md:max-w-2xl">
          Describe how you want the video transformed and the agent will plan and apply the edits
          using FFmpeg running locally in your browser. No uploads, everything happens on device.
        </p>
      </header>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col gap-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-700" htmlFor="prompt">
              Editing instructions
            </label>
            <textarea
              id="prompt"
              rows={5}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-800 outline-none transition focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-200"
              placeholder="e.g. Trim between 2s and 8s, convert to black and white, speed up by 1.5x"
            />
          </div>
          <button
            type="button"
            onClick={handlePlan}
            className="inline-flex items-center justify-center rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isProcessing}
          >
            Generate plan
          </button>

          <div className="space-y-3">
            <label htmlFor="file" className="text-sm font-medium text-zinc-700">
              Source video
            </label>
            <input
              id="file"
              type="file"
              accept={SUPPORTED_INPUT_TYPES.join(',')}
              onChange={handleFileChange}
              className="block w-full cursor-pointer rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-5 text-sm text-zinc-600 file:mr-4 file:rounded-lg file:border-0 file:bg-sky-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-sky-600 hover:border-sky-300 focus:outline-none focus:ring-2 focus:ring-sky-200"
            />
            <p className="text-xs text-zinc-500">
              MP4, MOV, WEBM, or OGG · processed entirely in your browser
            </p>
          </div>

          <button
            type="button"
            onClick={processVideo}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isProcessing || !sourceFile}
          >
            {isProcessing ? 'Processing...' : 'Run agent'}
          </button>

          {isLoadingCore && (
            <p className="text-xs text-zinc-500">Loading FFmpeg core files…</p>
          )}

          {isProcessing && (
            <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200">
              <div
                className="h-full rounded-full bg-sky-500 transition-all"
                style={{ width: `${Math.max(progress, 10)}%` }}
              />
            </div>
          )}

          {planSummary.length > 0 && (
            <div className="space-y-2 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
              <h2 className="text-sm font-semibold text-zinc-700">Planned steps</h2>
              <ul className="space-y-1 text-sm text-zinc-600">
                {planSummary.map((item, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-sky-500" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-sm font-semibold text-zinc-700">Preview</h2>
            <div className="mt-4 aspect-video w-full overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100">
              {sourceUrl ? (
                <video
                  ref={videoRef}
                  src={sourceUrl}
                  controls
                  className="h-full w-full bg-black object-contain"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-sm text-zinc-500">
                  Upload a video to preview
                </div>
              )}
            </div>
            {sourceFile && (
              <p className="mt-3 text-xs text-zinc-500">
                {sourceFile.name} · {(sourceFile.size / (1024 * 1024)).toFixed(2)} MB
              </p>
            )}
          </div>

          <div className="rounded-2xl border border-sky-200 bg-sky-50 p-6 shadow-inner">
            <h2 className="text-sm font-semibold text-sky-900">Result</h2>
            {outputUrl ? (
              <div className="mt-4 space-y-3 text-sm text-sky-900">
                <video
                  src={outputUrl}
                  controls
                  className="aspect-video w-full overflow-hidden rounded-xl border border-sky-200 bg-black object-contain"
                />
                <a
                  href={outputUrl}
                  download={outputFileName ?? 'agentic-output.mp4'}
                  className="inline-flex items-center justify-center rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500"
                >
                  Download {outputFileName ?? 'result'}
                </a>
              </div>
            ) : (
              <p className="mt-3 text-sm text-sky-800">
                Run the agent to generate an edited video. The output will appear here for download.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};

const buildFfmpegArgs = (operations: Operation[], format: 'mp4' | 'gif', input: string, output: string) => {
  const args: string[] = [];
  const trimOperation = operations.find((op): op is Extract<Operation, { kind: 'trim' }> => op.kind === 'trim');
  const start = trimOperation?.start ?? 0;
  const hasStart = typeof trimOperation?.start === 'number' && trimOperation.start > 0;
  const hasEnd = typeof trimOperation?.end === 'number' && trimOperation.end > 0;

  if (hasStart) {
    args.push('-ss', start.toFixed(2));
  }

  args.push('-i', input);

  if (hasEnd) {
    const duration = Math.max(0, (trimOperation?.end ?? 0) - start);
    if (duration > 0) {
      args.push('-t', duration.toFixed(2));
    }
  }

  const videoFilters: string[] = [];
  const audioFilters: string[] = [];
  let disableAudio = false;

  operations.forEach((operation) => {
    switch (operation.kind) {
      case 'grayscale':
        videoFilters.push('hue=s=0');
        break;
      case 'speed': {
        const factor = operation.factor;
        videoFilters.push(`setpts=${(1 / factor).toFixed(4)}*PTS`);
        const tempoChain = clampAudioTempoChain(factor);
        if (tempoChain.length > 0) {
          audioFilters.push(tempoChain.join(','));
        }
        break;
      }
      case 'mute':
        disableAudio = true;
        break;
      case 'brightness':
        videoFilters.push(`eq=brightness=${operation.value.toFixed(2)}`);
        break;
      case 'crop':
        if (operation.mode === 'square') {
          videoFilters.push('crop=min(iw,ih):min(iw,ih)');
        } else {
          videoFilters.push(
            'scale=720:-2:force_original_aspect_ratio=increase,crop=720:1280'
          );
        }
        break;
      default:
        break;
    }
  });

  if (format === 'gif') {
    videoFilters.push('fps=12');
  }

  if (videoFilters.length > 0) {
    args.push('-vf', videoFilters.join(','));
  }

  if (disableAudio) {
    args.push('-an');
  } else if (audioFilters.length > 0) {
    args.push('-af', audioFilters.join(','));
  }

  if (format === 'mp4') {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
    if (!disableAudio) {
      args.push('-c:a', 'aac');
    }
    args.push('-movflags', 'faststart');
  } else {
    args.push('-loop', '0');
  }

  args.push(output);
  return args;
};

const getExtension = (name: string) => {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return '.mp4';
  return name.slice(dot);
};

const safeDelete = async (ffmpeg: FFmpeg, path: string) => {
  try {
    await ffmpeg.deleteFile(path);
  } catch {
    // no-op
  }
};
