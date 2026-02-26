const html = `<img alt="4.png" data-content-id="4" style="border-radius: 4px; cursor: pointer;" src="data:image/jpeg;base64,/9j/4AAQSk">`;

const convertBase64ToCid = (html) => {
    const processed = html.replace(
        /<img\s[^>]*src="data:image\/[^"]+"/gi,
        (match) => {
            const contentIdMatch = match.match(/data-content-id="([^"]+)"/i);
            if (contentIdMatch) {
                const contentId = contentIdMatch[1];
                return match.replace(/src="data:image\/[^"]+"/, `src="cid:${contentId}"`);
            }
            return match;
        }
    );
    return processed;
};

console.log("Result:", convertBase64ToCid(html));

const htmlWithLineBreak = `<img alt="4.png" data-content-id="4" style="border-radius: 4px; cursor: pointer;"\nsrc="data:image/jpeg;base64,/9j/4AAQSk">`;
console.log("With Line Break:", convertBase64ToCid(htmlWithLineBreak));
