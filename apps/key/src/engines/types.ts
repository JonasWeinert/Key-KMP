export interface NativeBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface NativeTextCharacter {
  value: string;
  bounds?: NativeBounds;
}

export interface NativeTextPage {
  page: number;
  text: string;
  characters: NativeTextCharacter[];
}

export interface NativeLink {
  id: number;
  page: number;
  bounds: NativeBounds;
  target:
    | {
        kind: 'internal';
        page: number;
        xFraction?: number;
        yFraction?: number;
      }
    | {
        kind: 'external';
        url: string;
      };
}

export interface NativeDocumentInfo {
  id: string;
  title?: string;
  pages: Array<{ index: number; width: number; height: number }>;
  toc: Array<{ title: string; page: number; depth: number; destinationY?: number }>;
  links: NativeLink[];
}

export interface NativeSearchMatch {
  page: number;
  start: number;
  end: number;
  preview: string;
  bounds: NativeBounds[];
}

export interface ScientificReference {
  number: number;
  page: number;
  xFraction?: number;
  yFraction?: number;
  text: string;
  textRuns: NativeBounds[];
  metadata?: ScholarlyMetadata;
  metadataError?: string;
}

export interface ScholarlyMetadata {
  source: string;
  sources?: string[];
  title: string;
  abstractText?: string;
  tldrText?: string;
  authors: string[];
  year?: number;
  journal?: string;
  journalShort?: string;
  journalUrl?: string;
  doi?: string;
  openAccess?: boolean;
  fullTextUrl?: string;
  landingUrl?: string;
  certainty?: string;
}

export interface ScientificCitation {
  id: string;
  page: number;
  start: number;
  end: number;
  bounds: NativeBounds;
  source: string;
  numbers: number[];
}

export interface PaperPreprocessingResult {
  document: NativeDocumentInfo;
  isScientific: boolean;
  syntheticLinks: NativeLink[];
  citations: ScientificCitation[];
  references: ScientificReference[];
  signals: {
    referenceEntries: number;
    doiEntries: number;
    bracketCitations: number;
    superscriptCitations: number;
    concentratedInternalLinks: number;
  };
  processingMs: number;
}

export interface CompactSemanticRect {
  /** Normalized page-local values quantized to 0..65535. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SemanticSentence {
  start: number;
  end: number;
  text: string;
  rects: CompactSemanticRect[];
}

export interface SemanticBlock {
  kind: string;
  text: string;
  bounds: CompactSemanticRect;
  sentences: SemanticSentence[];
}

export interface SemanticPage {
  page: number;
  width: number;
  height: number;
  blocks: SemanticBlock[];
}

export interface SemanticDocument {
  version: number;
  documentHash: string;
  pageCount: number;
  onnxEnabled: boolean;
  processingMs: number;
  pages: SemanticPage[];
}

export type CompanionStage = 'analyzing' | 'enriching' | 'ready' | 'failed';

export type SemanticStatus =
  | 'pending'
  | 'processing'
  | 'indexing'
  | 'indexed'
  | 'ready'
  | 'failed';

export interface NativeCompanionSnapshot {
  generation: number;
  revision: number;
  stage: CompanionStage;
  document: NativeDocumentInfo;
  analysis?: PaperPreprocessingResult;
  semantic?: SemanticDocument;
  documentHash: string;
  semanticStatus: SemanticStatus;
  semanticCompleted: number;
  semanticTotal: number;
  semanticError?: string;
  hasNativeText: boolean;
  completedReferences: number;
  totalReferences: number;
  error?: string;
}
