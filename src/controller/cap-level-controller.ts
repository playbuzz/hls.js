/*
 * cap stream level to media size dimension controller
 */

import { Events } from '../events';
import type { Level } from '../types/level';
import type {
  ManifestParsedData,
  BufferCodecsData,
  MediaAttachingData,
  FPSDropLevelCappingData,
} from '../types/events';
import StreamController from './stream-controller';
import type { ComponentAPI } from '../types/component-api';
import type Hls from '../hls';

type RestrictedLevel = { width: number; height: number; bitrate: number };
class CapLevelController implements ComponentAPI {
  private hls: Hls;
  private autoLevelCapping: number;
  private firstLevel: number;
  private media: HTMLVideoElement | null;
  private restrictedLevels: RestrictedLevel[];
  private timer: number | undefined;
  private clientRect: { width: number; height: number } | null;
  private streamController?: StreamController;

  constructor(hls: Hls) {
    this.hls = hls;
    this.autoLevelCapping = Number.POSITIVE_INFINITY;
    this.firstLevel = -1;
    this.media = null;
    this.restrictedLevels = [];
    this.timer = undefined;
    this.clientRect = null;

    this.registerListeners();
  }

  public setStreamController(streamController: StreamController) {
    this.streamController = streamController;
  }

  public destroy() {
    this.unregisterListener();
    if (this.hls.config.capLevelToPlayerSize) {
      this.stopCapping();
    }
    this.media = null;
    this.clientRect = null;
    // @ts-ignore
    this.hls = this.streamController = null;
  }

  protected registerListeners() {
    const { hls } = this;
    hls.on(Events.FPS_DROP_LEVEL_CAPPING, this.onFpsDropLevelCapping, this);
    hls.on(Events.MEDIA_ATTACHING, this.onMediaAttaching, this);
    hls.on(Events.MANIFEST_PARSED, this.onManifestParsed, this);
    hls.on(Events.BUFFER_CODECS, this.onBufferCodecs, this);
    hls.on(Events.MEDIA_DETACHING, this.onMediaDetaching, this);
  }

  protected unregisterListener() {
    const { hls } = this;
    hls.off(Events.FPS_DROP_LEVEL_CAPPING, this.onFpsDropLevelCapping, this);
    hls.off(Events.MEDIA_ATTACHING, this.onMediaAttaching, this);
    hls.off(Events.MANIFEST_PARSED, this.onManifestParsed, this);
    hls.off(Events.BUFFER_CODECS, this.onBufferCodecs, this);
    hls.off(Events.MEDIA_DETACHING, this.onMediaDetaching, this);
  }

  protected onFpsDropLevelCapping(
    event: Events.FPS_DROP_LEVEL_CAPPING,
    data: FPSDropLevelCappingData
  ) {
    // Don't add a restricted level more than once
    const level = this.hls.levels[data.droppedLevel];
    if (this.isLevelAllowed(level)) {
      this.restrictedLevels.push({
        bitrate: level.bitrate,
        height: level.height,
        width: level.width,
      });
    }
  }

  protected onMediaAttaching(
    event: Events.MEDIA_ATTACHING,
    data: MediaAttachingData
  ) {
    this.media = data.media instanceof HTMLVideoElement ? data.media : null;
    this.clientRect = null;
  }

  protected onManifestParsed(
    event: Events.MANIFEST_PARSED,
    data: ManifestParsedData
  ) {
    const hls = this.hls;
    this.restrictedLevels = [];
    this.firstLevel = data.firstLevel;
    if (hls.config.capLevelToPlayerSize && data.video) {
      // Start capping immediately if the manifest has signaled video codecs
      this.startCapping();
    }
  }

  // Only activate capping when playing a video stream; otherwise, multi-bitrate audio-only streams will be restricted
  // to the first level
  protected onBufferCodecs(
    event: Events.BUFFER_CODECS,
    data: BufferCodecsData
  ) {
    const hls = this.hls;
    if (hls.config.capLevelToPlayerSize && data.video) {
      // If the manifest did not signal a video codec capping has been deferred until we're certain video is present
      this.startCapping();
    }
  }

  protected onMediaDetaching() {
    this.stopCapping();
  }

  detectPlayerSize() {
    if (this.media && this.mediaHeight > 0 && this.mediaWidth > 0) {
      const levels = this.hls.levels;
      if (levels.length) {
        const hls = this.hls;
        hls.autoLevelCapping = this.getMaxLevel(levels.length - 1);
        if (
          hls.autoLevelCapping > this.autoLevelCapping &&
          this.streamController
        ) {
          // if auto level capping has a higher value for the previous one, flush the buffer using nextLevelSwitch
          // usually happen when the user go to the fullscreen mode.
          this.streamController.nextLevelSwitch();
        }
        this.autoLevelCapping = hls.autoLevelCapping;
      }
    }
  }

  /*
   * returns level should be the one with the dimensions equal or greater than the media (player) dimensions (so the video will be downscaled)
   */
  getMaxLevel(capLevelIndex: number): number {
    const levels = this.hls.levels;
    if (!levels.length) {
      return -1;
    }

    const validLevels = levels.filter(
      (level, index) => this.isLevelAllowed(level) && index <= capLevelIndex
    );

    this.clientRect = null;
    const maxLevelByMediaSize = CapLevelController.getMaxLevelByMediaSize(
      validLevels,
      this.mediaWidth,
      this.mediaHeight
    );

    if (this.hls.maxLevelCapping !== -1) {
      return Math.min(this.hls.maxLevelCapping, maxLevelByMediaSize);
    }

    return maxLevelByMediaSize;
  }

  startCapping() {
    if (this.timer) {
      // Don't reset capping if started twice; this can happen if the manifest signals a video codec
      return;
    }
    this.autoLevelCapping = Number.POSITIVE_INFINITY;
    this.hls.firstLevel = this.getMaxLevel(this.firstLevel);
    self.clearInterval(this.timer);
    this.timer = self.setInterval(this.detectPlayerSize.bind(this), 1000);
    this.detectPlayerSize();
  }

  stopCapping() {
    this.restrictedLevels = [];
    this.firstLevel = -1;
    this.autoLevelCapping = Number.POSITIVE_INFINITY;
    if (this.timer) {
      self.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getDimensions(): { width: number; height: number } {
    if (this.clientRect) {
      return this.clientRect;
    }
    const media = this.media;
    const boundsRect = {
      width: 0,
      height: 0,
    };

    if (media) {
      const clientRect = media.getBoundingClientRect();
      boundsRect.width = clientRect.width;
      boundsRect.height = clientRect.height;
      if (!boundsRect.width && !boundsRect.height) {
        // When the media element has no width or height (equivalent to not being in the DOM),
        // then use its width and height attributes (media.width, media.height)
        boundsRect.width =
          clientRect.right - clientRect.left || media.width || 0;
        boundsRect.height =
          clientRect.bottom - clientRect.top || media.height || 0;
      }
    }
    this.clientRect = boundsRect;
    return boundsRect;
  }

  get mediaWidth(): number {
    return this.getDimensions().width * this.contentScaleFactor;
  }

  get mediaHeight(): number {
    return this.getDimensions().height * this.contentScaleFactor;
  }

  get contentScaleFactor(): number {
    let pixelRatio = 1;
    if (!this.hls.config.ignoreDevicePixelRatio) {
      try {
        pixelRatio = self.devicePixelRatio;
      } catch (e) {
        /* no-op */
      }
    }

    return pixelRatio;
  }

  private isLevelAllowed(level: Level): boolean {
    const restrictedLevels = this.restrictedLevels;
    return !restrictedLevels.some((restrictedLevel) => {
      return (
        level.bitrate === restrictedLevel.bitrate &&
        level.width === restrictedLevel.width &&
        level.height === restrictedLevel.height
      );
    });
  }

  static getMaxLevelByMediaSize(
    levels: Array<Level>,
    width: number,
    height: number
  ): number {
    if (!levels?.length) {
      return -1;
    }

    // Levels can have the same dimensions but differing bandwidths - since levels are ordered, we can look to the next
    // to determine whether we've chosen the greatest bandwidth for the media's dimensions
    const atGreatestBandwidth = (curLevel, nextLevel) => {
      if (!nextLevel) {
        return true;
      }

      return (
        curLevel.width !== nextLevel.width ||
        curLevel.height !== nextLevel.height
      );
    };

    // If we run through the loop without breaking, the media's dimensions are greater than every level, so default to
    // the max level
    let maxLevelIndex = levels.length - 1;

    for (let i = 0; i < levels.length; i += 1) {
      const level = levels[i];
      if (
        (level.width >= width || level.height >= height) &&
        atGreatestBandwidth(level, levels[i + 1])
      ) {
        maxLevelIndex = i;
        break;
      }
    }

    return maxLevelIndex;
  }
}

export default CapLevelController;
