import { Component, AfterViewInit, HostListener, ViewChild } from '@angular/core';
import { trigger, state, style, animate, transition } from '@angular/animations';
import { Svg, SvgItem, Point, SvgPoint, SvgControlPoint, formatNumber } from './svg';
import { MatIconRegistry } from '@angular/material/icon';
import { DomSanitizer } from '@angular/platform-browser';
import { StorageService } from './storage.service';
import { CanvasComponent } from './canvas/canvas.component';
import { Image } from './image';
import { UploadImageComponent } from './upload-image/upload-image.component';
import { ConfigService } from './config.service';
import { browserComputePathBoundingBox } from './svg-bbox';

export const kDefaultPath = {
  'Default': 'm3 0 0-15c1 0 2-1 2-2l0-78a1 1 0 00-10 0l0 78c0 1 1 2 2 2l0 15z',
  'Trapezoid': 'm5 0-3-105h-4l-3 105z',
  'Arrow 1': 'm5 0-5-105-5 105z',
  'Arrow 2': 'm4 0v-95h3l-7-10-7 10h3v95z',
  'Arrow 3': 'm-4-4a3 3 0 108 0l-2-96-2-5-2 5z',
  'sword': 'm-4-4a3 3 0 108 0l3-56-7-40-7 40z'
};

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  animations: [
    trigger('leftColumnParent', [
      transition(':enter', [])
    ]),
    trigger('leftColumn', [
      state('*', style({'max-width': '300px'})),
      transition(':enter', [style({'max-width': '0'}), animate('100ms ease')]),
      transition(':leave', [animate('100ms ease', style({'max-width': '0'}))])
    ])
  ]
})
export class AppComponent implements AfterViewInit {
  // Svg path data model:
  parsedPath: Svg;
  targetPoints: SvgPoint[] = [];
  controlPoints: SvgControlPoint[] = [];

  // Raw path:
  _rawPath = new URLSearchParams(window.location.search).get('path') || this.storage.getPath()?.path || kDefaultPath['Default'];
  pathName: string = '';
  invalidSyntax = false;

  // Undo/redo
  history: string[] = [];
  historyCursor = -1;
  historyDisabled = false;

  //  Path operations panel inputs:
  scaleX = 1;
  scaleY = 1;
  translateX = 0;
  translateY = 0;
  roundValuesDecimals = 1;

  // Canvas Data:
  @ViewChild(CanvasComponent) canvas?: CanvasComponent;
  canvasWidth = 100;
  canvasHeight = 100;
  strokeWidth: number = 1;

  // Dragged & hovered elements
  draggedPoint: SvgPoint | null = null;
  focusedItem: SvgItem | null = null;
  hoveredItem: SvgItem | null = null;
  wasCanvasDragged = false;
  draggedIsNew = false;
  dragging = false;

  // Images
  images: Image[] = [];
  focusedImage: Image | null = null;

  // UI State
  isLeftPanelOpened = true;
  isContextualMenuOpened = false;
  isEditingImages = false;

  // Utility functions:
  max = Math.max;
  trackByIndex = (idx: number, _: any) => idx;
  formatNumber = (v: number) => formatNumber(v, 4);

  constructor(
    matRegistry: MatIconRegistry,
    sanitizer: DomSanitizer,
    public cfg: ConfigService,
    private storage: StorageService
  ) {
    if (storage.isEmpty()) for (const [key, value] of Object.entries(kDefaultPath)) storage.addPath(key, value);
    (window as any).browserComputePathBoundingBox = browserComputePathBoundingBox;
    for (const icon of ['delete', 'logo', 'more', 'github', 'zoom_in', 'zoom_out', 'zoom_fit', 'help']) {
      matRegistry.addSvgIcon(icon, sanitizer.bypassSecurityTrustResourceUrl(`./assets/${icon}.svg`));
    }
    this.parsedPath = new Svg('');
    this.reloadPath(this.rawPath, true);
  }

  @HostListener('document:keydown', ['$event']) onKeyDown($event: any) {
    const tag = $event.target.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
      if ($event.shiftKey && ($event.metaKey || $event.ctrlKey) && $event.key.toLowerCase() === 'z') {
        this.redo();
        $event.preventDefault();
      } else if (($event.metaKey || $event.ctrlKey) && $event.key.toLowerCase() === 'z') {
        this.undo();
        $event.preventDefault();
      } else if (!$event.metaKey && !$event.ctrlKey && /^[mlvhcsqtaz]$/i.test($event.key)) {
        const isLower = $event.key === $event.key.toLowerCase();
        const key = $event.key.toUpperCase();
        if (isLower) {
          // Item insertion
          const lastItem = this.parsedPath.path.length ?  this.parsedPath.path[this.parsedPath.path.length - 1] : null;
          const prevItem = this.focusedItem || lastItem;
          if(this.canInsertAfter(prevItem, key)) {
            this.insert(key, prevItem, false);
            $event.preventDefault();
          }
        } else if (!isLower && this.focusedItem && this.canConvert(this.focusedItem, key)) {
          // Item convertion
          this.insert(key, this.focusedItem, true);
          $event.preventDefault();
        }
      } else if (!$event.metaKey && !$event.ctrlKey && $event.key === 'Escape') {
        if (this.dragging) {
          // If an element is being dragged, undo by reloading the current history entry
          this.reloadPath(this.history[this.historyCursor]);
        } else if(this.canvas){
          // stopDrag will unselect selected item if any
          this.canvas.stopDrag();
        }
        $event.preventDefault();
      } else if (!$event.metaKey && !$event.ctrlKey && ($event.key === 'Delete' || $event.key === 'Backspace')) {
        if (this.focusedItem && this.canDelete(this.focusedItem)) {
          this.delete(this.focusedItem);
          $event.preventDefault();
        }
        if (this.focusedImage) {
          this.deleteImage(this.focusedImage);
          $event.preventDefault();
        }
      }
    }
  }
  get decimals() {
    return  this.cfg.snapToGrid ? 0 : this.cfg.decimalPrecision;
 }

  ngAfterViewInit() {
    setTimeout(() => {
      this.zoomAuto();
    }, 0);
  }

  get rawPath(): string {
    return this._rawPath;
  }
  set rawPath(value: string) {
      this._rawPath = value;
      this.pushHistory();
  }

  setIsDragging(dragging: boolean) {
    this.dragging = dragging;
    this.setHistoryDisabled(dragging);
    if (!dragging) {
      this.draggedIsNew = false;
    }
  }

  setHistoryDisabled(value: boolean) {
    this.historyDisabled = value;
    if (!value) {
      this.pushHistory();
    }
  }

  pushHistory() {
    if (!this.historyDisabled && this.rawPath !== this.history[this.historyCursor]) {
      this.historyCursor ++;
      this.history.splice(this.historyCursor, this.history.length - this.historyCursor, this.rawPath);
      this.storage.addPath(null, this.rawPath);
    }
  }

  canUndo(): boolean {
    return this.historyCursor > 0 && !this.isEditingImages;
  }

  undo() {
    if (this.canUndo()) {
      this.historyDisabled = true;
      this.historyCursor --;
      this.reloadPath(this.history[this.historyCursor]);
      this.historyDisabled = false;
    }
  }

  canRedo(): boolean {
    return this.historyCursor < this.history.length - 1 && !this.isEditingImages;
  }

  redo() {
    if (this.canRedo()) {
      this.historyDisabled = true;
      this.historyCursor ++;
      this.reloadPath(this.history[this.historyCursor]);
      this.historyDisabled = false;
    }
  }

  updateViewPort(x: number, y: number, w: number | null, h: number | null, force = false) {
    if (!force && this.cfg.viewPortLocked) {
      return;
    }
    if (w === null && h !==null) {
      w = this.canvasWidth * h / this.canvasHeight;
    }
    if (h === null && w !==null) {
      h = this.canvasHeight * w / this.canvasWidth;
    }
    if (!w || !h) {
      return;
    }

    this.cfg.viewPortX = parseFloat((1 * x).toPrecision(6));
    this.cfg.viewPortY = parseFloat((1 * y).toPrecision(6));
    this.cfg.viewPortWidth = parseFloat((1 * w).toPrecision(4));
    this.cfg.viewPortHeight = parseFloat((1 * h).toPrecision(4));
    this.strokeWidth = this.cfg.viewPortWidth / this.canvasWidth;
  }

  insert(type: string, after: SvgItem | null, convert: boolean) {
    if (convert) {
      if(after) {
        this.focusedItem =
          this.parsedPath.changeType(after, after.relative ? type.toLowerCase() : type);
        this.afterModelChange();
      }
    } else {
      this.draggedIsNew = true;
      const pts = this.targetPoints;
      let point1: Point;

      let newItem: SvgItem | null = null;
      if (after) {
        point1 = after.targetLocation();
      } else if (pts.length === 0) {
        newItem = SvgItem.Make(['M', '0', '0']);
        this.parsedPath.insert(newItem);
        point1 = new Point(0, 0);
      } else {
        point1 = pts[pts.length - 1];
      }

      if (type.toLowerCase() !== 'm' || !newItem) {
        const relative = type.toLowerCase() === type;
        const X = (relative ?  0 : point1.x).toString();
        const Y = (relative ?  0 : point1.y).toString();
        switch (type.toLocaleLowerCase()) {
          case 'm': case 'l': case 't':
            newItem = SvgItem.Make([type, X, Y]) ; break;
          case 'h':
            newItem = SvgItem.Make([type, X]) ; break;
          case 'v':
            newItem = SvgItem.Make([type, Y]) ; break;
          case 's': case 'q':
            newItem = SvgItem.Make([type, X , Y, X, Y]) ; break;
          case 'c':
            newItem = SvgItem.Make([type, X , Y, X, Y, X, Y]) ; break;
          case 'a':
            newItem = SvgItem.Make([type, '1' , '1', '0', '0', '0', X, Y]) ; break;
          case 'z':
            newItem = SvgItem.Make([type]);
        }
        if(newItem) {
          this.parsedPath.insert(newItem, after ?? undefined);
        }
      }
      this.setHistoryDisabled(true);
      this.afterModelChange();

      if(newItem) {
        this.focusedItem = newItem;
        this.draggedPoint = newItem.targetLocation();
      }
    }
  }

  zoomAuto() {
    if (this.cfg.viewPortLocked) {
      return;
    }
    const bbox = browserComputePathBoundingBox(this.rawPath);

    const k = this.canvasHeight / this.canvasWidth;
    let w = bbox.width + 2;
    let h = bbox.height + 2;
    if (k < h / w) {
      w = h / k;
    } else {
      h = k * w;
    }

    this.updateViewPort(
      bbox.x + (bbox.width - w) / 2,
      bbox.y + (bbox.height - h) / 2,
      w,
      h
    );
  }

  scale(x: number, y: number) {
    this.parsedPath.scale(1 * x, 1 * y);
    this.scaleX = 1;
    this.scaleY = 1;
    this.afterModelChange();
  }

  translate(x: number, y: number) {
    this.parsedPath.translate(1 * x, 1 * y);
    this.translateX = 0;
    this.translateY = 0;
    this.afterModelChange();
  }

  setRelative(rel: boolean) {
    this.parsedPath.setRelative(rel);
    this.afterModelChange();
  }

  setValue(item: SvgItem, idx: number, val: number) {
    if (!isNaN(val)) {
      item.values[idx] = val;
      this.parsedPath.refreshAbsolutePositions();
      this.afterModelChange();
    }
  }

  delete(item: SvgItem) {
    this.focusedItem = null;
    this.parsedPath.delete(item);
    this.afterModelChange();
  }

  afterModelChange() {
    this.reloadPoints();
    this.rawPath = this.parsedPath.asString(4, this.cfg.minifyOutput);
  }

  roundValues(decimals: number) {
    this.reloadPath(this.parsedPath.asString(decimals));
    this.afterModelChange();
  }

  canDelete(item: SvgItem): boolean {
    const idx = this.parsedPath.path.indexOf(item);
    return idx > 0;
  }
  canInsertAfter(item: SvgItem | null, type: string): boolean {
    let previousType: string | null = null;
    if (item !== null) {
      previousType = item.getType().toUpperCase();
    } else if (this.parsedPath.path.length > 0) {
      previousType = this.parsedPath.path[this.parsedPath.path.length - 1].getType().toUpperCase();
    }
    if (!previousType) {
      return type !== 'Z';
    }
    if (previousType === 'M') {
      return type !== 'M' && type !== 'Z' && type !== 'T' && type !== 'S';
    }
    if (previousType === 'Z') {
      return type !== 'Z' && type !== 'T' && type !== 'S';
    }
    if (previousType === 'C' || previousType === 'S' ) {
      return type !== 'T';
    }
    if (previousType === 'Q' || previousType === 'T' ) {
      return type !== 'S';
    }
    return type !== 'T' && type !== 'S';
  }
  canConvert(item: SvgItem, to: string): boolean {
    const idx = this.parsedPath.path.indexOf(item) ;
    if (idx === 0) {
      return false;
    }
    if (idx > 0) {
      return this.canInsertAfter(this.parsedPath.path[idx - 1], to);
    }
    return false;
  }

  getTooltip(item: SvgItem, idx: number): string {
    const labels: {[key: string]: string[]} = {
      M: ['x', 'y'],
      m: ['dx', 'dy'],
      L: ['x', 'y'],
      l: ['dx', 'dy'],
      V: ['y'],
      v: ['dy'],
      H: ['x'],
      h: ['dx'],
      C: ['x1', 'y1', 'x2', 'y2', 'x', 'y'],
      c: ['dx1', 'dy1', 'dx2', 'dy2', 'dx', 'dy'],
      S: ['x2', 'y2', 'x', 'y'],
      s: ['dx2', 'dy2', 'dx', 'dy'],
      Q: ['x1', 'y1', 'x', 'y'],
      q: ['dx1', 'dy1', 'dx', 'dy'],
      T: ['x', 'y'],
      t: ['dx', 'dy'],
      A: ['rx', 'ry', 'x-axis-rotation', 'large-arc-flag', 'sweep-flag', 'x', 'y'],
      a: ['rx', 'ry', 'x-axis-rotation', 'large-arc-flag', 'sweep-flag', 'dx', 'dy']
    };
    return labels[item.getType()][idx];
  }

  openPath(newPath: string, name: string): void {
    this.pathName = name;
    this.history = [];
    this.historyCursor = -1;
    this.reloadPath(newPath, true);
  }

  reloadPath(newPath: string, autozoom = false): void {
    this.hoveredItem = null;
    this.focusedItem = null;
    this.rawPath = newPath;
    this.invalidSyntax = false;
    try {
      this.parsedPath = new Svg(this.rawPath);
      this.reloadPoints();
      if (autozoom) {
        this.zoomAuto();
      }
    } catch (e) {
      this.invalidSyntax = true;
      if (!this.parsedPath) {
        this.parsedPath = new Svg('');
      }
    }
  }

  reloadPoints(): void {
    this.targetPoints = this.parsedPath.targetLocations();
    this.controlPoints = this.parsedPath.controlLocations();
  }

  toggleLeftPanel(): void {
    this.isLeftPanelOpened = !this.isLeftPanelOpened;
  }

  deleteImage(image: Image): void {
    this.images.splice(this.images.indexOf(image), 1);
    this.focusedImage = null;
  }

  addImage(newImage: Image): void {
    this.focusedImage = newImage;
    this.images.push(newImage);
  }

  cancelAddImage(): void {
    if(this.images.length === 0) {
      this.isEditingImages = false;
      this.focusedImage = null;
    }
  }

  toggleImageEditing(upload: UploadImageComponent): void {
    this.isEditingImages = !this.isEditingImages;
    this.focusedImage = null;
    this.focusedItem = null;
    if (this.isEditingImages && this.images.length === 0) {
      upload.openDialog();
    }
  }

  focusItem(it: SvgItem | null): void {
    if(it !== this.focusedItem) {
      this.focusedItem = it;
      const idx = this.parsedPath.path.indexOf(this.focusedItem!);
      document.getElementById(`svg_command_row_${idx}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest'
      });
    }
  }
}
