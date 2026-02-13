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
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Save, FileDown, Trash2 } from "lucide-react";

interface EmailComposerProps {
    subject: string;
    onSubjectChange: (subject: string) => void;
    htmlContent: string;
    onContentChange: (html: string) => void;
    onImageUpload?: (file: File) => Promise<{ url: string; contentId: string }>;
    onPreview?: () => void;
}

// Max dimensions for compressed images
const MAX_IMAGE_WIDTH = 800;
const MAX_IMAGE_HEIGHT = 800;
const JPEG_QUALITY = 0.8;

/**
 * Compress an image file to reduce its size
 * Returns a compressed base64 string
 */
async function compressImage(file: File): Promise<{ base64: string; originalSize: number; compressedSize: number }> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = document.createElement("img");
            img.onload = () => {
                // Calculate new dimensions maintaining aspect ratio
                let { width, height } = img;
                const originalSize = file.size;

                if (width > MAX_IMAGE_WIDTH || height > MAX_IMAGE_HEIGHT) {
                    const ratio = Math.min(MAX_IMAGE_WIDTH / width, MAX_IMAGE_HEIGHT / height);
                    width = Math.round(width * ratio);
                    height = Math.round(height * ratio);
                }

                // Create canvas and draw resized image
                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    reject(new Error("Could not get canvas context"));
                    return;
                }

                ctx.drawImage(img, 0, 0, width, height);

                // Convert to JPEG for better compression
                const compressedBase64 = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
                const compressedSize = Math.round((compressedBase64.length * 3) / 4); // Approximate size from base64

                console.log(`Image compressed: ${(originalSize / 1024).toFixed(1)}KB -> ${(compressedSize / 1024).toFixed(1)}KB (${Math.round((1 - compressedSize / originalSize) * 100)}% reduction)`);

                resolve({
                    base64: compressedBase64,
                    originalSize,
                    compressedSize,
                });
            };
            img.onerror = () => reject(new Error("Failed to load image"));
            img.src = e.target?.result as string;
        };
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsDataURL(file);
    });
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

    // Link Popover State
    const [isLinkPopoverOpen, setIsLinkPopoverOpen] = useState(false);
    const [linkUrl, setLinkUrl] = useState("");
    const [linkText, setLinkText] = useState("");

    // Font Popover State
    const [isFontPopoverOpen, setIsFontPopoverOpen] = useState(false);
    const [currentFont, setCurrentFont] = useState("Arial");

    // Template Management
    const templates = useQuery(api.emailTemplates.list) || [];
    const saveTemplate = useMutation(api.emailTemplates.create);
    const deleteTemplate = useMutation(api.emailTemplates.remove);

    // State for popovers
    const [isSavePopoverOpen, setIsSavePopoverOpen] = useState(false);
    const [newTemplateName, setNewTemplateName] = useState("");
    const [isLoadPopoverOpen, setIsLoadPopoverOpen] = useState(false);

    const handleSaveTemplate = async () => {
        if (!newTemplateName.trim()) return;
        try {
            await saveTemplate({
                name: newTemplateName,
                subject: subject,
                htmlContent: htmlContent,
            });
            alert("Template saved successfully");
            setIsSavePopoverOpen(false);
            setNewTemplateName("");
        } catch (error) {
            alert("Failed to save template");
            console.error(error);
        }
    };

    const handleLoadTemplate = (templateId: string) => {
        const template = templates.find((t) => t._id === templateId);
        if (template) {
            if (confirm("Loading a template will overwrite current subject and content. Continue?")) {
                onSubjectChange(template.subject);
                onContentChange(template.htmlContent);
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

    // Only set initial content once
    useEffect(() => {
        if (editorRef.current && !isInitialized.current && htmlContent) {
            editorRef.current.innerHTML = htmlContent;
            isInitialized.current = true;
        }
    }, [htmlContent]);

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

    const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        // Focus editor first
        editorRef.current?.focus();

        try {
            // Compress the image before inserting
            const { base64, originalSize, compressedSize } = await compressImage(file);
            const contentId = file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9]/g, "_");

            document.execCommand(
                "insertHTML",
                false,
                `<img src="${base64}" alt="${file.name}" data-content-id="${contentId}" style="max-width: 100%; height: auto; border-radius: 4px; cursor: pointer;" />`
            );
            updateContent();

            // Call the upload handler to store the image for sending
            // We need to pass the compressed image, not the original
            if (onImageUpload) {
                try {
                    // Create a new File with compressed data
                    const response = await fetch(base64);
                    const blob = await response.blob();
                    const compressedFile = new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), {
                        type: "image/jpeg",
                    });
                    await onImageUpload(compressedFile);
                } catch (error) {
                    console.error("Failed to register image:", error);
                }
            }
        } catch (error) {
            console.error("Failed to process image:", error);
            // Fallback to original method if compression fails
            const reader = new FileReader();
            reader.onload = async (readerEvent) => {
                const base64 = readerEvent.target?.result as string;
                const contentId = file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9]/g, "_");

                document.execCommand(
                    "insertHTML",
                    false,
                    `<img src="${base64}" alt="${file.name}" data-content-id="${contentId}" style="max-width: 100%; height: auto; border-radius: 4px;" />`
                );
                updateContent();

                if (onImageUpload) {
                    try {
                        await onImageUpload(file);
                    } catch (err) {
                        console.error("Failed to register image:", err);
                    }
                }
            };
            reader.readAsDataURL(file);
        }

        // Reset file input
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
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
        { icon: Image, action: handleImageClick, title: "Insert Image" },
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
                    type="text"
                    value={subject}
                    onChange={(e) => onSubjectChange(e.target.value)}
                    placeholder="Enter email subject..."
                    className="w-full px-4 py-3 border border-gray-200 rounded-lg text-base outline-none focus:ring-2 focus:ring-[#1E3A5F]/20 focus:border-[#1E3A5F]"
                />
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
                                disabled={!newTemplateName.trim()}
                                className="w-full h-8 text-xs"
                            >
                                Save Template
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
                                    onMouseDown={(e) => e.preventDefault()} // Prevent focus loss
                                    onClick={() =>
                                        btn.action
                                            ? btn.action()
                                            : execCommand(btn.command!, btn.value)
                                    }
                                    className="p-2 hover:bg-gray-200 rounded transition-colors"
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
                        style={{
                            fontFamily: "Arial, sans-serif",
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
