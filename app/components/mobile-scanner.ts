import { action } from '@ember/object';
import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';

interface MobileScannerArgs {
  onScan: (file: File) => void;
  onClose: () => void;
}

export default class MobileScannerComponent extends Component<MobileScannerArgs> {
  // State
  @tracked viewState: 'preview' | 'camera' | 'adjust' = 'preview';
  @tracked capturedImages: string[] = [];
  @tracked isGenerating = false;
  @tracked isProcessingImage = false;
  @tracked cameraError: string | null = null;
  @tracked liveCorners: [number, number][] | null = null;
  @tracked libsLoading = false;

  static MAX_PAGES = 20;

  // DOM & Media Refs
  private stream: MediaStream | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private highlightCanvas: HTMLCanvasElement | null = null;
  private detectionTimer: ReturnType<typeof setInterval> | null = null;

  // Adjustment State
  private capturedImageData: ImageData | null = null;
  private capturedWidth = 0;
  private capturedHeight = 0;
  private corners: [number, number][] = [];
  private draggingCorner = -1;
  private previewCanvas: HTMLCanvasElement | null = null;
  private cornerCanvas: HTMLCanvasElement | null = null;
  private cleanupCornerEvents: (() => void) | null = null;
  private cvReady = false;

  get capturedImagesWithIndex() {
    return this.capturedImages.map((url, index) => ({ url, index, pageNumber: index + 1 }));
  }

  get isAtPageLimit() {
    return this.capturedImages.length >= MobileScannerComponent.MAX_PAGES;
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Libs
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  private loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  private async waitForOpenCV(): Promise<void> {
    if (this.cvReady) return;
    this.libsLoading = true;
    try {
      await this.loadScript('https://docs.opencv.org/4.8.0/opencv.js');
      await new Promise<void>((resolve) => {
        const check = () => {
          const cv = (window as any).cv;
          if (cv && cv.Mat) { this.cvReady = true; resolve(); }
          else if (cv && cv.onRuntimeInitialized) {
            const old = cv.onRuntimeInitialized;
            cv.onRuntimeInitialized = () => { old?.(); this.cvReady = true; resolve(); };
          } else { setTimeout(check, 100); }
        };
        check();
      });
    } catch (e) {
      console.warn('OpenCV load failed', e);
    } finally {
      this.libsLoading = false;
    }
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Camera & Video
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  @action async openCamera() {
    if (this.isAtPageLimit) return;
    this.cameraError = null;
    this.waitForOpenCV(); // start loading in background

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      this.viewState = 'camera';
    } catch {
      this.cameraError = 'Camera access denied. Enable permissions in browser settings.';
    }
  }

  @action stopCamera() {
    if (this.detectionTimer) { clearInterval(this.detectionTimer); this.detectionTimer = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    this.viewState = 'preview';
    this.liveCorners = null;
  }

  @action setupVideoElement(videoEl: HTMLVideoElement) {
    this.videoElement = videoEl;
    if (this.stream) videoEl.srcObject = this.stream;
  }

  @action setupHighlightCanvas(canvas: HTMLCanvasElement) {
    this.highlightCanvas = canvas;
    const start = () => {
      if (!this.videoElement) return;
      canvas.width = this.videoElement.videoWidth;
      canvas.height = this.videoElement.videoHeight;
      this.startDetectionLoop();
    };
    if (this.videoElement && this.videoElement.readyState >= 2) start();
    else this.videoElement?.addEventListener('playing', start, { once: true });
  }

  private startDetectionLoop() {
    if (this.detectionTimer) return;
    this.detectionTimer = setInterval(() => this.runDetection(), 250);
  }

  private runDetection() {
    if (!this.cvReady || !this.videoElement || !this.highlightCanvas) return;
    if (this.viewState !== 'camera') return;

    const cv = (window as any).cv;
    const scale = Math.min(1, 640 / Math.max(this.videoElement.videoWidth, this.videoElement.videoHeight));
    const dw = Math.round(this.videoElement.videoWidth * scale);
    const dh = Math.round(this.videoElement.videoHeight * scale);
    
    const detectCanvas = document.createElement('canvas');
    detectCanvas.width = dw; detectCanvas.height = dh;
    detectCanvas.getContext('2d')!.drawImage(this.videoElement, 0, 0, dw, dh);

    const found = this.detectDocumentCorners(detectCanvas, cv);
    
    const ctx = this.highlightCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.highlightCanvas.width, this.highlightCanvas.height);

    if (found) {
      this.liveCorners = found.map(([x, y]) => [x / scale, y / scale] as [number, number]);
      this.drawLiveOverlay(ctx, this.highlightCanvas.width, this.highlightCanvas.height, this.liveCorners);
    } else {
      this.liveCorners = null;
    }
  }

  private drawLiveOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, pts: [number, number][]) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    pts.slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    pts.slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.closePath();
    ctx.strokeStyle = '#00C896';
    ctx.lineWidth = Math.max(3, w * 0.004);
    ctx.stroke();
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Capture & Load
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  @action async capturePhoto() {
    if (!this.videoElement || !this.videoElement.videoWidth) return;
    if (this.detectionTimer) clearInterval(this.detectionTimer);
    
    this.capturedWidth = this.videoElement.videoWidth;
    this.capturedHeight = this.videoElement.videoHeight;
    
    const tmp = document.createElement('canvas');
    tmp.width = this.capturedWidth; tmp.height = this.capturedHeight;
    tmp.getContext('2d')!.drawImage(this.videoElement, 0, 0, this.capturedWidth, this.capturedHeight);
    this.capturedImageData = tmp.getContext('2d')!.getImageData(0, 0, this.capturedWidth, this.capturedHeight);

    // Initial corner guess
    this.corners = this.liveCorners ?? this.defaultCorners(this.capturedWidth, this.capturedHeight);
    
    // Stop camera, move to adjust
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.viewState = 'adjust';
  }

  @action loadFromFile() {
    document.getElementById('scanner-file-input')?.click();
  }

  @action async processFileInput(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;

    this.isProcessingImage = true;
    try {
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = (ev) => resolve(ev.target?.result as string);
        reader.readAsDataURL(file);
      });
      const img = new Image();
      await new Promise<void>((resolve) => { img.onload = () => resolve(); img.src = dataUrl; });

      this.capturedWidth = img.width;
      this.capturedHeight = img.height;
      const tmp = document.createElement('canvas');
      tmp.width = this.capturedWidth; tmp.height = this.capturedHeight;
      tmp.getContext('2d')!.drawImage(img, 0, 0);
      this.capturedImageData = tmp.getContext('2d')!.getImageData(0, 0, this.capturedWidth, this.capturedHeight);
      
      await this.waitForOpenCV();
      const cv = (window as any).cv;
      this.corners = (this.cvReady ? this.detectDocumentCorners(tmp, cv) : null) ?? this.defaultCorners(this.capturedWidth, this.capturedHeight);
      
      this.viewState = 'adjust';
    } finally {
      this.isProcessingImage = false;
      (e.target as HTMLInputElement).value = '';
    }
  }

  private defaultCorners(w: number, h: number): [number, number][] {
    const mx = w * 0.08, my = h * 0.08;
    return [[mx, my], [w - mx, my], [w - mx, h - my], [mx, h - my]];
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Adjust Screen & Canvas
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  @action setupPreviewCanvas(canvas: HTMLCanvasElement) {
    this.previewCanvas = canvas;
    canvas.width = this.capturedWidth;
    canvas.height = this.capturedHeight;
    if (this.capturedImageData) {
      canvas.getContext('2d')!.putImageData(this.capturedImageData, 0, 0);
    }
  }

  @action setupCornerCanvas(canvas: HTMLCanvasElement) {
    this.cornerCanvas = canvas;
    canvas.width = this.capturedWidth;
    canvas.height = this.capturedHeight;
    this.drawCornerCanvas();
    
    this.cleanupCornerEvents?.();

    const getCoords = (cx: number, cy: number): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [(cx - r.left) * (canvas.width / r.width), (cy - r.top) * (canvas.height / r.height)];
    };

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      const t = e.touches[0];
      this.draggingCorner = this.nearestCorner(...getCoords(t.clientX, t.clientY));
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (this.draggingCorner < 0) return;
      const t = e.touches[0];
      const [x, y] = getCoords(t.clientX, t.clientY);
      this.moveCorner(this.draggingCorner, x, y);
      this.drawMagnifier(x, y, t.clientX, t.clientY);
    };
    const onTouchEnd = () => { this.draggingCorner = -1; this.hideMagnifier(); };

    const onMouseDown = (e: MouseEvent) => {
      this.draggingCorner = this.nearestCorner(...getCoords(e.clientX, e.clientY));
    };
    const onMouseMove = (e: MouseEvent) => {
      if (this.draggingCorner < 0) return;
      const [x, y] = getCoords(e.clientX, e.clientY);
      this.moveCorner(this.draggingCorner, x, y);
    };
    const onMouseUp = () => { this.draggingCorner = -1; this.hideMagnifier(); };

    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove',  onTouchMove,  { passive: false });
    canvas.addEventListener('touchend',   onTouchEnd);
    canvas.addEventListener('mousedown',  onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',   onMouseUp);

    this.cleanupCornerEvents = () => {
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove',  onTouchMove);
      canvas.removeEventListener('touchend',   onTouchEnd);
      canvas.removeEventListener('mousedown',  onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup',   onMouseUp);
    };
  }

  private nearestCorner(x: number, y: number): number {
    const threshold = Math.min(this.capturedWidth, this.capturedHeight) * 0.15;
    let best = -1, bestDist = Infinity;
    for (let i = 0; i < this.corners.length; i++) {
      const d = Math.sqrt((this.corners[i][0] - x) ** 2 + (this.corners[i][1] - y) ** 2);
      if (d < threshold && d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  }

  private moveCorner(idx: number, x: number, y: number) {
    this.corners[idx] = [Math.max(0, Math.min(this.capturedWidth, x)), Math.max(0, Math.min(this.capturedHeight, y))];
    this.drawCornerCanvas();
  }

  private drawCornerCanvas() {
    if (!this.cornerCanvas) return;
    const ctx = this.cornerCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.cornerCanvas.width, this.cornerCanvas.height);

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(0, 0, this.cornerCanvas.width, this.cornerCanvas.height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.moveTo(this.corners[0][0], this.corners[0][1]);
    this.corners.slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.moveTo(this.corners[0][0], this.corners[0][1]);
    this.corners.slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.closePath();
    ctx.strokeStyle = '#00C896';
    ctx.lineWidth = Math.max(3, this.capturedWidth * 0.004);
    ctx.stroke();

    const r = Math.max(18, Math.min(this.capturedWidth, this.capturedHeight) * 0.035);
    this.corners.forEach(([x, y]) => {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#00C896'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke();
    });
  }

  private drawMagnifier(canvasX: number, canvasY: number, clientX: number, clientY: number) {
    const mag = document.getElementById('magnifier');
    if (!mag || !this.previewCanvas) return;
    const container = document.getElementById('adjust-container')!;
    const cr = container.getBoundingClientRect();
    
    const SIZE = 96; const ZOOM = 2.5;
    let mx = (clientX - cr.left) - SIZE / 2;
    let my = (clientY - cr.top) - SIZE - 30;
    if (my < 10) my = (clientY - cr.top) + 40;
    mx = Math.max(4, Math.min(cr.width - SIZE - 4, mx));

    mag.style.display = 'block';
    mag.style.left = `${mx}px`;
    mag.style.top = `${my}px`;

    const mCtx = document.createElement('canvas');
    mCtx.width = SIZE; mCtx.height = SIZE;
    const ctx = mCtx.getContext('2d')!;
    
    ctx.drawImage(this.previewCanvas,
      canvasX - (SIZE / 2) / ZOOM, canvasY - (SIZE / 2) / ZOOM, SIZE / ZOOM, SIZE / ZOOM,
      0, 0, SIZE, SIZE);

    ctx.strokeStyle = '#00C896'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(SIZE / 2, 0); ctx.lineTo(SIZE / 2, SIZE);
    ctx.moveTo(0, SIZE / 2); ctx.lineTo(SIZE, SIZE / 2);
    ctx.stroke();

    mag.innerHTML = '';
    mag.appendChild(mCtx);
  }

  private hideMagnifier() {
    const mag = document.getElementById('magnifier');
    if (mag) mag.style.display = 'none';
  }

  @action autoFixCorners() {
    if (!this.capturedImageData || !this.cvReady) return;
    const cv = (window as any).cv;
    const tmp = document.createElement('canvas');
    tmp.width = this.capturedWidth; tmp.height = this.capturedHeight;
    tmp.getContext('2d')!.putImageData(this.capturedImageData, 0, 0);
    const detected = this.detectDocumentCorners(tmp, cv);
    if (detected) {
      this.corners = detected;
      this.drawCornerCanvas();
    }
  }

  @action cancelAdjust() {
    this.cleanupCornerEvents?.();
    this.capturedImageData = null;
    this.viewState = 'preview'; // Go back to preview, user can add page again
  }

  @action confirmAdjust() {
    if (!this.capturedImageData || !this.cvReady) return;
    const cv = (window as any).cv;
    
    let src: any, srcPts: any, dstPts: any, M: any, warped: any, brightened: any, kernel: any, sharpened: any;
    try {
      const srcCanvas = document.createElement('canvas');
      srcCanvas.width = this.capturedWidth; srcCanvas.height = this.capturedHeight;
      srcCanvas.getContext('2d')!.putImageData(this.capturedImageData, 0, 0);
      src = cv.imread(srcCanvas);

      // Inset slightly to remove bad edges
      const ixSide = this.capturedWidth * 0.018;
      const iyTop = this.capturedHeight * 0.028;
      const iyBottom = this.capturedHeight * 0.018;
      const [tl, tr, br, bl] = this.corners;
      const ic: [number, number][] = [
        [tl[0] + ixSide, tl[1] + iyTop],
        [tr[0] - ixSide, tr[1] + iyTop],
        [br[0] - ixSide, br[1] - iyBottom],
        [bl[0] + ixSide, bl[1] - iyBottom],
      ];

      const dist = (a: [number, number], b: [number, number]) => Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2);
      const W = Math.round(Math.max(dist(ic[1], ic[0]), dist(ic[2], ic[3])));
      const H = Math.round(Math.max(dist(ic[0], ic[3]), dist(ic[1], ic[2])));
      
      srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [ic[0][0], ic[0][1], ic[1][0], ic[1][1], ic[2][0], ic[2][1], ic[3][0], ic[3][1]]);
      dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0,0, W-1,0, W-1,H-1, 0,H-1]);

      M = cv.getPerspectiveTransform(srcPts, dstPts);
      warped = new cv.Mat();
      cv.warpPerspective(src, warped, M, new cv.Size(W, H), cv.INTER_CUBIC, cv.BORDER_REPLICATE);

      // Brightness + contrast
      brightened = new cv.Mat();
      warped.convertTo(brightened, -1, 1.12, 18);

      // Sharpen
      kernel = cv.matFromArray(3, 3, cv.CV_32F, [0,-0.4,0, -0.4,2.6,-0.4, 0,-0.4,0]);
      sharpened = new cv.Mat();
      cv.filter2D(brightened, sharpened, -1, kernel);

      const resultCanvas = document.createElement('canvas');
      resultCanvas.width = W; resultCanvas.height = H;
      cv.imshow(resultCanvas, sharpened);

      this.capturedImages = [...this.capturedImages, resultCanvas.toDataURL('image/jpeg', 0.85)];
      
    } catch (e) {
      console.error('Processing error', e);
      // Fallback
      const tmp = document.createElement('canvas');
      tmp.width = this.capturedWidth; tmp.height = this.capturedHeight;
      tmp.getContext('2d')!.putImageData(this.capturedImageData, 0, 0);
      this.capturedImages = [...this.capturedImages, tmp.toDataURL('image/jpeg', 0.8)];
    } finally {
      src?.delete(); srcPts?.delete(); dstPts?.delete(); M?.delete();
      warped?.delete(); brightened?.delete(); kernel?.delete(); sharpened?.delete();
    }

    this.cleanupCornerEvents?.();
    this.capturedImageData = null;
    this.viewState = 'preview';
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // OpenCV Core Algos
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  private detectDocumentCorners(canvas: HTMLCanvasElement, cv: any): [number, number][] | null {
    let src: any, gray: any, blurred: any, edges: any, dilated: any, kernel: any, contours: any, hierarchy: any;
    try {
      src = cv.imread(canvas);
      gray = new cv.Mat(); blurred = new cv.Mat(); edges = new cv.Mat(); dilated = new cv.Mat();
      kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      contours = new cv.MatVector(); hierarchy = new cv.Mat();

      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
      cv.Canny(blurred, edges, 50, 150);
      cv.dilate(edges, dilated, kernel);
      cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

      const imgArea = canvas.width * canvas.height;
      let bestApprox: any = null;
      let bestArea = 0;

      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const area = cv.contourArea(c);
        c.delete();
        if (area < imgArea * 0.05 || area > imgArea * 0.98) continue;

        const cont = contours.get(i);
        const peri = cv.arcLength(cont, true);
        const approx = new cv.Mat();
        cv.approxPolyDP(cont, approx, 0.02 * peri, true);
        cont.delete();

        if (approx.rows === 4 && area > bestArea) {
          bestApprox?.delete(); bestArea = area; bestApprox = approx;
        } else { approx.delete(); }
      }

      let result: [number, number][] | null = null;
      if (bestApprox && bestArea > imgArea * 0.05) {
        const pts: [number, number][] = [];
        for (let i = 0; i < 4; i++) pts.push([bestApprox.data32S[i * 2], bestApprox.data32S[i * 2 + 1]]);
        
        // order corners
        const sorted = [...pts].sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
        const tl = sorted[0], br = sorted[3];
        const mid = [sorted[1], sorted[2]];
        const tr = mid[0][0] >= mid[1][0] ? mid[0] : mid[1];
        const bl = mid[0][0] >= mid[1][0] ? mid[1] : mid[0];
        result = [tl, tr, br, bl];
        
        bestApprox.delete();
      } else { bestApprox?.delete(); }

      return result;
    } catch (e) {
      console.warn('Detection failed:', e); return null;
    } finally {
      src?.delete(); gray?.delete(); blurred?.delete(); edges?.delete();
      dilated?.delete(); kernel?.delete(); contours?.delete(); hierarchy?.delete();
    }
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Preview Screen Actions
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  @action removePage(index: number) {
    this.capturedImages = this.capturedImages.filter((_, i) => i !== index);
  }

  @action handleClose() {
    this.stopCamera();
    this.args.onClose();
  }

  willDestroy() {
    super.willDestroy();
    this.stopCamera();
    this.cleanupCornerEvents?.();
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // PDF Gen
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  @action async generatePDF() {
    if (!this.capturedImages.length) return;
    this.isGenerating = true;
    try {
      await this.loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
      const { jsPDF } = (window as any).jspdf;
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const w = pdf.internal.pageSize.getWidth();
      const h = pdf.internal.pageSize.getHeight();

      for (let i = 0; i < this.capturedImages.length; i++) {
        if (i > 0) pdf.addPage();
        pdf.addImage(this.capturedImages[i], "JPEG", 0, 0, w, h, '', 'FAST');
      }

      const blob = pdf.output("blob");
      const file = new File([blob], `scan-${Date.now()}.pdf`, { type: "application/pdf" });
      this.args.onScan(file);
    } catch (e) {
      console.error(e);
    } finally {
      this.isGenerating = false;
    }
  }
}