/**
 * Inline critical styles onto content HTML elements so they survive
 * email-client sanitisation (Gmail, Outlook.com, Yahoo all strip <style> blocks).
 *
 * Only touches elements that do NOT already have an inline style attribute,
 * so explicitly-styled elements (e.g. unsubscribe footer) are left untouched.
 */
function inlineContentStyles(html: string): string {
  // Helper: add a style attribute only to tags that don't already have one.
  const addStyleIfMissing = (tag: string, styles: string) =>
    html.replace(
      new RegExp(`<${tag}(?![^>]*style=)(?=[\\s>])`, "gi"),
      `<${tag} style="${styles}"`
    );

  html = addStyleIfMissing("p", "margin:0 0 6px 0;padding:0");
  html = addStyleIfMissing("ul", "margin:8px 0;padding-left:24px");
  html = addStyleIfMissing("ol", "margin:8px 0;padding-left:24px");
  html = addStyleIfMissing("li", "margin:0 0 4px 0");
  html = addStyleIfMissing("h1", "margin:0 0 12px 0;padding:0");
  html = addStyleIfMissing("h2", "margin:0 0 10px 0;padding:0");
  html = addStyleIfMissing("h3", "margin:0 0 8px 0;padding:0");
  html = addStyleIfMissing("img", "max-width:100%;height:auto;display:block");

  return html;
}

export const wrapEmail = (content: string, title: string = "Notification"): string => {
  const processedContent = inlineContentStyles(content);

  return `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
  <title>${title}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:AllowPNG/>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    /* Reset — kept as progressive enhancement for clients that DO read <style> */
    body, table, td, p, a, li { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
    body { margin: 0; padding: 0; width: 100% !important; -webkit-font-smoothing: antialiased; }
    a { color: #1a73e8; }
    @media only screen and (max-width: 620px) {
      .email-container { width: 100% !important; max-width: 100% !important; }
      .email-content { padding: 12px 16px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,sans-serif;">
  <!--[if mso]>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f4;"><tr><td align="center">
  <![endif]-->
  <div style="background-color:#f4f4f4;padding:20px 0;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" width="100%" style="max-width:600px;margin:0 auto;">
      <tr>
        <td align="center" style="padding:0;">
          <!--[if mso]>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600"><tr><td>
          <![endif]-->
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" class="email-container" style="max-width:600px;background-color:#ffffff;border-radius:8px;overflow:hidden;">
            <!-- Content -->
            <tr>
              <td class="email-content" style="padding:20px 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.45;color:#333333;">
                ${processedContent}
              </td>
            </tr>
            <!-- Footer -->
            <tr>
              <td style="background-color:#f8f9fa;padding:14px 24px;text-align:center;font-size:12px;color:#888888;border-top:1px solid #eeeeee;font-family:Arial,Helvetica,sans-serif;">
                <p style="margin:0;padding:0;">&copy; ${new Date().getFullYear()} TTT Group. All rights reserved.</p>
              </td>
            </tr>
          </table>
          <!--[if mso]>
          </td></tr></table>
          <![endif]-->
        </td>
      </tr>
    </table>
  </div>
  <!--[if mso]>
  </td></tr></table>
  <![endif]-->
</body>
</html>
  `.trim();
};
