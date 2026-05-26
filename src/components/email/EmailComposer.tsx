"use client";

import { useRef, useEffect, useState } from "react";
import {
    Bold,
    Italic,
    Underline,
    AlignLeft,
    AlignCenter,
    AlignRight,
    Link,
    Image,
    List,
    ListOrdered,
    Heading1,
    Heading2,
    Undo,
    Redo,
    X,
    Maximize2,
    Minimize2,
    Paperclip,
    Eye,
    Type,
    Tag,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Save, FileDown, Trash2 } from "lucide-react";
import {
    getConvexSiteUrl,
    normalizeInlineBase64Images,
} from "@/lib/imageUpload";

interface EmailComposerProps {
    subject: string;
    onSubjectChange: (subject: string) => void;
    htmlContent: string;
    onContentChange: (html: string) => void;
    onImageUpload?: (file: File) => Promise<{ url: string; contentId: string }>;
    onPreview?: () => void;
    fontSize?: string;
    onFontSizeChange?: (size: string) => void;
}

// Bandwidth-only compression. Storage size is no longer a constraint (images
// live in Convex storage), so we just keep dimensions reasonable for email
// rendering and let JPEG quality stay near-lossless.
const MAX_IMAGE_DIMENSION = 1600;
const JPEG_QUALITY = 0.92;
// Files under this size aren't worth re-encoding — gains are negligible and
// it preserves the original bytes (PNG transparency, source quality, etc).
const SKIP_COMPRESSION_BYTES = 300 * 1024;

function escapeHtmlAttribute(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

interface CompressedImage {
    blob: Blob;
    contentType: string;
    filename: string;
}

function deriveFilename(original: string, contentType: string): string {
    const ext = contentType === "image/png" ? ".png"
        : contentType === "image/gif" ? ".gif"
        : contentType === "image/webp" ? ".webp"
        : ".jpg";
    return original.replace(/\.[^.]+$/, "") + ext;
}

async function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = document.createElement("img");
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Failed to decode image"));
        img.src = src;
    });
}

async function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error("Canvas encoding produced no blob"))),
            mime,
            quality,
        );
    });
}

/**
 * Compress an image for upload. Returns a Blob ready to POST to storage.
 *
 * Preserves the source format when it's already efficient: PNGs stay PNG
 * (transparency / crisp text), GIFs are passed through unchanged (animation),
 * and small files skip re-encoding entirely. Everything else is rendered to
 * JPEG at high quality with high-quality canvas resampling.
 */
async function compressImage(file: File): Promise<CompressedImage> {
    const isPng = file.type === "image/png";
    const isGif = file.type === "image/gif";

    if (isGif || file.size <= SKIP_COMPRESSION_BYTES) {
        return { blob: file, contentType: file.type, filename: file.name };
    }

    const objectUrl = URL.createObjectURL(file);
    try {
        const img = await loadImage(objectUrl);
        let { width, height } = img;
        const needsResize = width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION;

        if (isPng && !needsResize) {
            return { blob: file, contentType: file.type, filename: file.name };
        }

        if (needsResize) {
            const ratio = Math.min(MAX_IMAGE_DIMENSION / width, MAX_IMAGE_DIMENSION / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Could not get canvas 2d context");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, width, height);

        const outputMime = isPng ? "image/png" : "image/jpeg";
        const blob = await canvasToBlob(canvas, outputMime, JPEG_QUALITY);

        return {
            blob,
            contentType: outputMime,
            filename: deriveFilename(file.name, outputMime),
        };
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

export function EmailComposer({
    subject,
    onSubjectChange,
    htmlContent,
    onContentChange,
    onImageUpload,
    onPreview,
    attachments = [],
    onAttachmentsChange,
    fontSize = "18px",
    onFontSizeChange,
}: EmailComposerProps & {
    attachments?: File[];
    onAttachmentsChange?: (attachments: File[]) => void;
}) {
    const editorRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const attachmentInputRef = useRef<HTMLInputElement>(null);
    const isInitialized = useRef(false);
    const [selectedImage, setSelectedImage] = useState<HTMLImageElement | null>(null);
    const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);

    // Track which field was last focused so merge chip inserts into the right place
    const [activeField, setActiveField] = useState<"subject" | "body">("body");
    const subjectRef = useRef<HTMLInputElement>(null);

    // Link Popover State
    const [isLinkPopoverOpen, setIsLinkPopoverOpen] = useState(false);
    const [linkUrl, setLinkUrl] = useState("");
    const [linkText, setLinkText] = useState("");

    // Font Popover State
    const [isFontPopoverOpen, setIsFontPopoverOpen] = useState(false);
    const [currentFont, setCurrentFont] = useState("Arial");
    const [isFontSizePopoverOpen, setIsFontSizePopoverOpen] = useState(false);

    // Available merge fields for personalisation
    const MERGE_FIELDS = [
        { label: "{firstName}", description: "Recipient's first name", example: "John" },
        { label: "{fullName}", description: "Recipient's full name", example: "John Smith" },
        { label: "{email}", description: "Recipient's email address", example: "john@email.com" },
    ];

    const insertMergeField = (field: string) => {
        if (activeField === "subject") {
            // Insert at cursor position in the subject input
            const input = subjectRef.current;
            if (input) {
                const start = input.selectionStart ?? subject.length;
                const end = input.selectionEnd ?? subject.length;
                const newValue = subject.slice(0, start) + field + subject.slice(end);
                onSubjectChange(newValue);
                // Restore cursor after the inserted text
                setTimeout(() => {
                    input.focus();
                    input.setSelectionRange(start + field.length, start + field.length);
                }, 0);
            } else {
                onSubjectChange(subject + field);
            }
        } else {
            // Insert into rich-text body at cursor position
            editorRef.current?.focus();
            document.execCommand("insertText", false, field);
            updateContent();
        }
    };

    // Template Management
    const templates = useQuery(api.emailTemplates.list) || [];
    const saveTemplate = useMutation(api.emailTemplates.create);
    const deleteTemplate = useMutation(api.emailTemplates.remove);
    const generateUploadUrl = useMutation(api.files.generateUploadUrl);

    // State for popovers
    const [isSavePopoverOpen, setIsSavePopoverOpen] = useState(false);
    const [newTemplateName, setNewTemplateName] = useState("");
    const [isLoadPopoverOpen, setIsLoadPopoverOpen] = useState(false);
    const [isSavingTemplate, setIsSavingTemplate] = useState(false);

    const handleSaveTemplate = async () => {
        if (!newTemplateName.trim()) return;
        setIsSavingTemplate(true);
        try {
            // Migrate any inline base64 images to storage URLs before saving so
            // htmlContent stays well under Convex's 1 MiB per-value limit.
            // Newly-inserted images already use storage URLs; this only does
            // work for legacy content (older templates, pasted HTML).
            const { html: normalizedHtml } = await normalizeInlineBase64Images(
                htmlContent,
                generateUploadUrl,
                getConvexSiteUrl(),
            );
            if (normalizedHtml !== htmlContent) {
                onContentChange(normalizedHtml);
                if (editorRef.current) editorRef.current.innerHTML = normalizedHtml;
            }

            await saveTemplate({
                name: newTemplateName,
                subject: subject,
                htmlContent: normalizedHtml,
                fontSize: fontSize,
            });
            alert("Template saved successfully");
            setIsSavePopoverOpen(false);
            setNewTemplateName("");
        } catch (error) {
            alert(`Failed to save template: ${error instanceof Error ? error.message : "Unknown error"}`);
            console.error(error);
        } finally {
            setIsSavingTemplate(false);
        }
    };

    const handleLoadTemplate = (templateId: string) => {
        const template = templates.find((t) => t._id === templateId);
        if (template) {
            if (confirm("Loading a template will overwrite current subject and content. Continue?")) {
                onSubjectChange(template.subject);
                onContentChange(template.htmlContent);
                if (onFontSizeChange && template.fontSize) {
                    onFontSizeChange(template.fontSize);
                }
                if (editorRef.current) {
                    editorRef.current.innerHTML = template.htmlContent;
                }
                setIsLoadPopoverOpen(false);
            }
        }
    };

    const handleDeleteTemplate = async (templateId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (confirm("Are you sure you want to delete this template?")) {
            await deleteTemplate({ id: templateId as any });
        }
    };

    const fonts = [
        { name: "Arial", value: "Arial, sans-serif" },
        { name: "Roboto", value: "Roboto, sans-serif" },
        { name: "Helvetica", value: "Helvetica, sans-serif" },
        { name: "Times New Roman", value: "'Times New Roman', serif" },
        { name: "Courier New", value: "'Courier New', monospace" },
        { name: "Verdana", value: "Verdana, sans-serif" },
        { name: "Georgia", value: "Georgia, serif" },
        { name: "Tahoma", value: "Tahoma, sans-serif" },
        { name: "Trebuchet MS", value: "'Trebuchet MS', sans-serif" },
    ];

    const fontSizes = [
        "12px", "14px", "16px", "18px", "20px", "24px", "28px", "32px"
    ];

    // Only set initial content once
    useEffect(() => {
        if (editorRef.current && !isInitialized.current && htmlContent) {
            editorRef.current.innerHTML = htmlContent;
            isInitialized.current = true;
        }
    }, [htmlContent]);

    // Handle paste: strip external font-size styles so the editor's fontSize applies
    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;

        const handlePaste = (e: ClipboardEvent) => {
            e.preventDefault();
            const html = e.clipboardData?.getData("text/html");
            const plain = e.clipboardData?.getData("text/plain") || "";

            if (html) {
                // Strip font-size from pasted HTML so the editor container's fontSize takes effect
                const cleaned = html
                    .replace(/font-size\s*:\s*[^;"']+;?/gi, "")
                    .replace(/\s*style="\s*"/gi, "")
                    // Replace <font size="..."> tags with plain <span> tags
                    .replace(/<font[^>]*>/gi, "<span>")
                    .replace(/<\/font>/gi, "</span>");
                document.execCommand("insertHTML", false, cleaned);
            } else {
                document.execCommand("insertText", false, plain);
            }
            updateContent();
        };

        editor.addEventListener("paste", handlePaste);
        return () => editor.removeEventListener("paste", handlePaste);
    }, []);

    // Handle clicks on images for selection
    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;

        const handleClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.tagName === "IMG") {
                const img = target as HTMLImageElement;
                setSelectedImage(img);
                setImageSize({ width: img.width, height: img.height });
                img.classList.add("ring-2", "ring-blue-500");
            } else {
                // Deselect if clicking elsewhere
                if (selectedImage) {
                    selectedImage.classList.remove("ring-2", "ring-blue-500");
                }
                setSelectedImage(null);
                setImageSize(null);
            }
        };

        editor.addEventListener("click", handleClick);
        return () => editor.removeEventListener("click", handleClick);
    }, [selectedImage]);

    const execCommand = (command: string, value?: string) => {
        // Focus the editor first to ensure commands work
        editorRef.current?.focus();
        document.execCommand(command, false, value);
        updateContent();
    };

    // Apply font-size inline to the current selection, or all content if nothing is selected
    const applyFontSizeToSelection = (size: string) => {
        const editor = editorRef.current;
        if (!editor) return;
        editor.focus();

        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && editor.contains(selection.anchorNode)) {
            // Use execCommand('fontSize') as a marker, then replace <font> tags with styled spans
            document.execCommand("fontSize", false, "1");
            const fontTags = editor.querySelectorAll('font[size="1"]');
            fontTags.forEach((font) => {
                const span = document.createElement("span");
                span.style.fontSize = size;
                span.innerHTML = font.innerHTML;
                font.replaceWith(span);
            });
        } else {
            // No selection: apply to all text nodes by setting it on every block element
            const blocks = editor.querySelectorAll("p, li, div, span, td, h1, h2, h3, h4, h5, h6");
            if (blocks.length > 0) {
                blocks.forEach((el) => {
                    (el as HTMLElement).style.fontSize = size;
                });
            }
            // Also set on the container for any bare text nodes
            editor.style.fontSize = size;
        }
        updateContent();
    };

    const updateContent = () => {
        if (editorRef.current) {
            onContentChange(editorRef.current.innerHTML);
        }
    };

    const handleImageClick = () => {
        fileInputRef.current?.click();
    };

    const handleAttachmentClick = () => {
        attachmentInputRef.current?.click();
    };

    const handleAttachmentUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !onAttachmentsChange) return;

        onAttachmentsChange([...attachments, file]);

        // Reset input
        if (attachmentInputRef.current) {
            attachmentInputRef.current.value = "";
        }
    };

    const removeAttachment = (index: number) => {
        if (!onAttachmentsChange) return;
        const newAttachments = [...attachments];
        newAttachments.splice(index, 1);
        onAttachmentsChange(newAttachments);
    };

    const [isUploadingImage, setIsUploadingImage] = useState(false);

    const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (fileInputRef.current) fileInputRef.current.value = "";
        if (!file) return;

        if (!onImageUpload) {
            console.error("EmailComposer: onImageUpload prop is required for image insertion");
            alert("Image upload is not configured in this context");
            return;
        }

        editorRef.current?.focus();
        setIsUploadingImage(true);
        try {
            const compressed = await compressImage(file);
            const uploadFile = new File([compressed.blob], compressed.filename, {
                type: compressed.contentType,
            });
            const { url, contentId } = await onImageUpload(uploadFile);

            const safeAlt = escapeHtmlAttribute(file.name);
            const safeUrl = escapeHtmlAttribute(url);
            const safeCid = escapeHtmlAttribute(contentId);

            document.execCommand(
                "insertHTML",
                false,
                `<img src="${safeUrl}" alt="${safeAlt}" data-content-id="${safeCid}" style="max-width: 100%; height: auto; border-radius: 4px; cursor: pointer;" />`,
            );
            updateContent();
        } catch (error) {
            console.error("Failed to upload image:", error);
            alert(`Failed to upload image: ${error instanceof Error ? error.message : "Unknown error"}`);
        } finally {
            setIsUploadingImage(false);
        }
    };

    const insertLink = () => {
        if (linkUrl) {
            // If user provided text, create a full anchor tag
            if (linkText) {
                execCommand("insertHTML", `<a href="${linkUrl}" target="_blank" rel="noopener noreferrer">${linkText}</a>`);
            } else {
                // Standard behavior - link the selected text or URL as text
                execCommand("createLink", linkUrl);
            }
            setIsLinkPopoverOpen(false);
            setLinkUrl("");
            setLinkText("");
        }
    };

    const changeFont = (fontValue: string, fontName: string) => {
        execCommand("fontName", fontValue);
        setCurrentFont(fontName);
        setIsFontPopoverOpen(false);
    };

    // Resize selected image
    const resizeImage = (scale: number) => {
        if (!selectedImage || !imageSize) return;

        const newWidth = Math.round(imageSize.width * scale);
        const newHeight = Math.round(imageSize.height * scale);

        selectedImage.style.width = `${newWidth}px`;
        selectedImage.style.height = `${newHeight}px`;
        setImageSize({ width: newWidth, height: newHeight });
        updateContent();
    };

    // Delete selected image
    const deleteImage = () => {
        if (!selectedImage) return;
        selectedImage.remove();
        setSelectedImage(null);
        setImageSize(null);
        updateContent();
    };

    const toolbarButtons = [
        { icon: Bold, command: "bold", title: "Bold" },
        { icon: Italic, command: "italic", title: "Italic" },
        { icon: Underline, command: "underline", title: "Underline" },
        { divider: true },
        {
            icon: Type,
            custom: (
                <Popover open={isFontPopoverOpen} onOpenChange={setIsFontPopoverOpen}>
                    <PopoverTrigger asChild>
                        <button
                            type="button"
                            className="p-2 hover:bg-gray-200 rounded transition-colors flex items-center gap-1"
                            title="Font Family"
                            onMouseDown={(e) => e.preventDefault()}
                        >
                            <Type size={16} className="text-gray-600" />
                            <span className="text-xs text-gray-500 w-16 truncate text-left">{currentFont}</span>
                        </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-48 p-1" align="start">
                        <div className="space-y-1">
                            {fonts.map((font) => (
                                <button
                                    key={font.name}
                                    onClick={() => changeFont(font.value, font.name)}
                                    className={`w-full text-left px-2 py-1.5 text-sm rounded hover:bg-gray-100 ${currentFont === font.name ? "bg-gray-100 font-medium" : ""
                                        }`}
                                    style={{ fontFamily: font.value }}
                                >
                                    {font.name}
                                </button>
                            ))}
                        </div>
                    </PopoverContent>
                </Popover>
            )
        },
        {
            icon: Type,
            custom: (
                <Popover open={isFontSizePopoverOpen} onOpenChange={setIsFontSizePopoverOpen}>
                    <PopoverTrigger asChild>
                        <button
                            type="button"
                            className="p-2 hover:bg-gray-200 rounded transition-colors flex items-center gap-1"
                            title="Font Size"
                            onMouseDown={(e) => e.preventDefault()}
                        >
                            <span className="text-xs text-gray-500 w-8 text-center font-medium">{fontSize}</span>
                        </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-24 p-1" align="start">
                        <div className="space-y-1">
                            {fontSizes.map((size) => (
                                <button
                                    key={size}
                                    onClick={() => {
                                        applyFontSizeToSelection(size);
                                        if (onFontSizeChange) onFontSizeChange(size);
                                        setIsFontSizePopoverOpen(false);
                                    }}
                                    className={`w-full text-left px-2 py-1.5 text-sm rounded hover:bg-gray-100 ${fontSize === size ? "bg-gray-100 font-medium" : ""
                                        }`}
                                >
                                    {size}
                                </button>
                            ))}
                        </div>
                    </PopoverContent>
                </Popover>
            )
        },
        { divider: true },
        { icon: Heading1, command: "formatBlock", value: "h1", title: "Heading 1" },
        { icon: Heading2, command: "formatBlock", value: "h2", title: "Heading 2" },
        { divider: true },
        { icon: AlignLeft, command: "justifyLeft", title: "Align Left" },
        { icon: AlignCenter, command: "justifyCenter", title: "Center" },
        { icon: AlignRight, command: "justifyRight", title: "Align Right" },
        { divider: true },
        { icon: List, command: "insertUnorderedList", title: "Bullet List" },
        { icon: ListOrdered, command: "insertOrderedList", title: "Numbered List" },
        { divider: true },
        {
            icon: Link,
            custom: (
                <Popover open={isLinkPopoverOpen} onOpenChange={setIsLinkPopoverOpen}>
                    <PopoverTrigger asChild>
                        <button
                            type="button"
                            className="p-2 hover:bg-gray-200 rounded transition-colors"
                            title="Insert Link"
                            onMouseDown={(e: React.MouseEvent) => {
                                // Prevent focus loss and stop propagation to prevent editor blur if possible
                                e.preventDefault();
                            }}
                            onClick={() => {
                                setIsLinkPopoverOpen(true);
                                // Pre-fill text if there's a selection?
                                const selection = window.getSelection();
                                if (selection && !selection.isCollapsed) {
                                    setLinkText(selection.toString());
                                }
                            }}
                        >
                            <Link size={16} className="text-gray-600" />
                        </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-80 p-4" align="start">
                        <div className="space-y-4">
                            <h4 className="font-medium text-sm">Insert Link</h4>
                            <div className="space-y-2">
                                <label htmlFor="link-text" className="text-sm font-medium">Text to display</label>
                                <Input
                                    id="link-text"
                                    value={linkText}
                                    onChange={(e) => setLinkText(e.target.value)}
                                    placeholder="Click here"
                                />
                            </div>
                            <div className="space-y-2">
                                <label htmlFor="link-url" className="text-sm font-medium">URL</label>
                                <Input
                                    id="link-url"
                                    value={linkUrl}
                                    onChange={(e) => setLinkUrl(e.target.value)}
                                    placeholder="https://"
                                />
                            </div>
                            <div className="flex justify-end gap-2">
                                <Button variant="ghost" onClick={() => setIsLinkPopoverOpen(false)} className="px-2 py-1 h-8 text-sm">
                                    Cancel
                                </Button>
                                <Button onClick={insertLink} className="px-2 py-1 h-8 text-sm">
                                    Insert
                                </Button>
                            </div>
                        </div>
                    </PopoverContent>
                </Popover>
            )
        },
        { icon: Image, action: handleImageClick, title: isUploadingImage ? "Uploading image..." : "Insert Image", disabled: isUploadingImage },
        { icon: Paperclip, action: handleAttachmentClick, title: "Attach File" },
        { divider: true },
        { icon: Undo, command: "undo", title: "Undo" },
        { icon: Redo, command: "redo", title: "Redo" },
        ...(onPreview ? [{ divider: true }, { icon: Eye, action: onPreview, title: "Preview" }] : []),
    ];

    return (
        <div className="space-y-4">
            {/* Subject Line */}
            <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Subject Line
                </label>
                <input
                    ref={subjectRef}
                    type="text"
                    value={subject}
                    onChange={(e) => onSubjectChange(e.target.value)}
                    onFocus={() => setActiveField("subject")}
                    placeholder="Enter email subject..."
                    className="w-full px-4 py-3 border border-gray-200 rounded-lg text-base outline-none focus:ring-2 focus:ring-[#1E3A5F]/20 focus:border-[#1E3A5F]"
                />
            </div>

            {/* ── Merge Fields ── */}
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 space-y-3">
                <div className="flex items-center gap-2">
                    <Tag size={15} className="text-blue-600 shrink-0" />
                    <span className="text-sm font-semibold text-blue-800">Personalisation / Merge Fields</span>
                </div>
                <p className="text-xs text-blue-700 leading-relaxed">
                    Click a field below to insert it at your cursor — in the subject line <em>or</em> the email body.
                    Each placeholder is replaced with the recipient&apos;s real data when the email is sent.
                </p>
                <div className="flex flex-wrap gap-2">
                    {MERGE_FIELDS.map((f) => (
                        <button
                            key={f.label}
                            type="button"
                            title={`${f.description} — e.g. "${f.example}"`}
                            onClick={() => insertMergeField(f.label)}
                            className="group flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono bg-white text-blue-700 border border-blue-300 rounded-full hover:bg-blue-600 hover:text-white hover:border-blue-600 transition-colors shadow-sm"
                        >
                            <span>{f.label}</span>
                            <span className="text-blue-400 group-hover:text-blue-200 font-sans not-italic">→ {f.example}</span>
                        </button>
                    ))}
                </div>
                <p className="text-xs text-blue-500">
                    💡 <strong>Tip:</strong> Click inside the subject or body first, then click a field chip to insert it at your cursor.
                </p>
            </div>

            {/* Template Actions */}
            <div className="flex gap-2 justify-end">
                <Popover open={isLoadPopoverOpen} onOpenChange={setIsLoadPopoverOpen}>
                    <PopoverTrigger asChild>
                        <Button variant="secondary" className="gap-2 border border-gray-300 h-9 px-3 text-sm">
                            <FileDown size={14} />
                            Load Template
                        </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-80 p-0" align="end">
                        <div className="p-3 border-b border-gray-100 font-medium text-sm">Select a Template</div>
                        <div className="max-h-60 overflow-y-auto p-1">
                            {templates.length === 0 ? (
                                <div className="p-4 text-center text-sm text-gray-500">No templates saved yet</div>
                            ) : (
                                <div className="space-y-1">
                                    {templates.map((t) => (
                                        <div
                                            key={t._id}
                                            onClick={() => handleLoadTemplate(t._id)}
                                            className="flex items-center justify-between p-2 hover:bg-gray-100 rounded cursor-pointer group"
                                        >
                                            <span className="text-sm truncate flex-1">{t.name}</span>
                                            <button
                                                onClick={(e) => handleDeleteTemplate(t._id, e)}
                                                className="p-1 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                                                title="Delete template"
                                            >
                                                <Trash2 size={12} />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </PopoverContent>
                </Popover>

                <Popover open={isSavePopoverOpen} onOpenChange={setIsSavePopoverOpen}>
                    <PopoverTrigger asChild>
                        <Button variant="secondary" className="gap-2 border border-gray-300 h-9 px-3 text-sm">
                            <Save size={14} />
                            Save as Template
                        </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-80 p-4" align="end">
                        <div className="space-y-3">
                            <h4 className="font-medium text-sm">Save New Template</h4>
                            <div className="space-y-1">
                                <label className="text-xs text-gray-500">Template Name</label>
                                <Input
                                    value={newTemplateName}
                                    onChange={(e) => setNewTemplateName(e.target.value)}
                                    placeholder="e.g., Monthly Newsletter"
                                    className="h-8"
                                />
                            </div>
                            <Button
                                onClick={handleSaveTemplate}
                                disabled={!newTemplateName.trim() || isSavingTemplate}
                                className="w-full h-8 text-xs"
                            >
                                {isSavingTemplate ? "Saving..." : "Save Template"}
                            </Button>
                        </div>
                    </PopoverContent>
                </Popover>
            </div>


            {/* Attachments List */}
            {onAttachmentsChange && attachments.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {attachments.map((file, idx) => (
                        <div key={idx} className="flex items-center gap-2 bg-gray-100 px-3 py-1.5 rounded-full text-sm border border-gray-200">
                            <Paperclip size={14} className="text-gray-500" />
                            <span className="truncate max-w-[200px]" title={file.name}>{file.name}</span>
                            <span className="text-xs text-gray-400">({(file.size / 1024).toFixed(0)}KB)</span>
                            <button
                                onClick={() => removeAttachment(idx)}
                                className="ml-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full p-0.5 transition-colors"
                            >
                                <X size={14} />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* Rich Text Editor */}
            <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Email Content
                </label>
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                    {/* Toolbar */}
                    <div className="bg-gray-50 border-b border-gray-200 p-2 flex flex-wrap gap-1 items-center">
                        {toolbarButtons.map((btn, idx) =>
                            btn.divider ? (
                                <div
                                    key={idx}
                                    className="w-px h-6 bg-gray-300 mx-1 self-center"
                                />
                            ) : btn.custom ? (
                                <div key={idx}>{btn.custom}</div>
                            ) : (
                                <button
                                    key={idx}
                                    type="button"
                                    disabled={btn.disabled}
                                    onMouseDown={(e) => e.preventDefault()} // Prevent focus loss
                                    onClick={() =>
                                        btn.action
                                            ? btn.action()
                                            : execCommand(btn.command!, btn.value)
                                    }
                                    className="p-2 hover:bg-gray-200 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                                    title={btn.title}
                                >
                                    {btn.icon && <btn.icon size={16} className="text-gray-600" />}
                                </button>
                            )
                        )}
                    </div>

                    {/* Image Controls - shown when an image is selected */}
                    {selectedImage && (
                        <div className="bg-blue-50 border-b border-blue-200 px-3 py-2 flex items-center gap-3">
                            <span className="text-sm font-medium text-blue-800">Image selected</span>
                            <div className="flex items-center gap-1">
                                <button
                                    type="button"
                                    onClick={() => resizeImage(0.75)}
                                    className="p-1.5 hover:bg-blue-100 rounded transition-colors"
                                    title="Shrink 25%"
                                >
                                    <Minimize2 size={14} className="text-blue-600" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => resizeImage(1.25)}
                                    className="p-1.5 hover:bg-blue-100 rounded transition-colors"
                                    title="Enlarge 25%"
                                >
                                    <Maximize2 size={14} className="text-blue-600" />
                                </button>
                            </div>
                            {imageSize && (
                                <span className="text-xs text-blue-600">
                                    {imageSize.width} × {imageSize.height}px
                                </span>
                            )}
                            <button
                                type="button"
                                onClick={deleteImage}
                                className="p-1.5 hover:bg-red-100 rounded transition-colors ml-auto"
                                title="Delete image"
                            >
                                <X size={14} className="text-red-600" />
                            </button>
                        </div>
                    )}

                    {/* Editor Area */}
                    <div
                        ref={editorRef}
                        contentEditable
                        className="min-h-[600px] p-4 outline-none prose prose-sm max-w-none"
                        onInput={updateContent}
                        onFocus={() => setActiveField("body")}
                        style={{
                            fontFamily: "Arial, sans-serif",
                            fontSize: fontSize,
                        }}
                    />
                </div>

                {/* Hidden file input for images */}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleImageUpload}
                    className="hidden"
                />

                {/* Hidden file input for attachments */}
                <input
                    ref={attachmentInputRef}
                    type="file"
                    onChange={handleAttachmentUpload}
                    className="hidden"
                />
            </div>

            {/* Preview Toggle */}
            <div className="text-sm text-gray-500">
                <span className="font-medium">Tip:</span> Click on an image to resize or delete it. Images are automatically compressed to keep email size small.
            </div>
        </div>
    );
}
