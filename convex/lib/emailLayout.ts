export const wrapEmail = (content: string, title: string = "Notification"): string => {
  return `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>${title}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    table, td, div, h1, p { font-family: Arial, sans-serif; }
    body { margin: 0; padding: 0; background-color: #f4f4f4; }
    .email-container { max-width: 800px; margin: 0 auto; background-color: #ffffff; padding: 0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    img { max-width: 100%; width: 100%; height: auto; display: block; }
    a { color: #007bff; text-decoration: none; }
    /* Force tables to expand to full width of container */
    table { width: 100% !important; }
    @media only screen and (max-width: 800px) {
      .email-container { width: 100% !important; padding: 0 !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;">
  <div style="background-color:#f4f4f4;padding:20px 0;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#f4f4f4;">
      <tr>
        <td align="center">
          <!-- Main Container -->
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:800px;margin:0 auto;background-color:#ffffff;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);">
            <tr>
              <td style="padding:0;font-family:Arial,sans-serif;font-size:18px;line-height:1.5;color:#333333;">
                ${content}
              </td>
            </tr>
            <!-- Optional Footer -->
            <tr>
              <td style="background-color:#f8f9fa;padding:15px;text-align:center;font-size:12px;color:#888888;border-top:1px solid #eeeeee;">
                <p style="margin:0;">&copy; ${new Date().getFullYear()} TTT Communication Tool. All rights reserved.</p>
              </td>
            </tr>
          </table>
          <!-- End Main Container -->
        </td>
      </tr>
    </table>
  </div>
</body>
</html>
  `.trim();
};
