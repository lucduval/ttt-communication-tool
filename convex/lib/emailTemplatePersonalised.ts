import type { PersonalisedCopy } from "./gemini";
import type { CalculatedOptions } from "./taxCalculator";

function fmt(n: number): string {
    const abs = Math.abs(n);
    if (abs >= 1_000_000) {
        const m = abs / 1_000_000;
        const str = m >= 10 ? Math.round(m).toString() : m.toFixed(1).replace(".", ",");
        return `R${str}m`;
    }
    if (abs >= 10_000) {
        return `R${Math.round(abs / 1_000)}k`;
    }
    if (abs >= 1_000) {
        return `R${(abs / 1_000).toFixed(1).replace(".", ",")}k`;
    }
    return `R${Math.round(abs / 100) * 100}`;
}

function fmtMonthly(annual: number): string {
    return fmt(annual / 12);
}

export function buildPersonalisedEmail(params: {
    copy: PersonalisedCopy;
    scenarios: CalculatedOptions;
    recipientName: string;
    yearOfAssessment: number;
    targetYear: number;
    logoUrl?: string;
}): string {
    const { copy, scenarios, yearOfAssessment, targetYear, logoUrl } = params;
    const { currentSituation, optionA, optionB, optionC, retirementProjection: rp } = scenarios;

    // Brand palette based on #0077BB
    const brand = "#0077BB";
    const brandDark = "#005C91";
    const brandDarker = "#004466";
    const brandLight = "#E6F3FA";    // very light tint for stat boxes
    const brandMedLight = "#CCE7F5"; // medium light for option B
    const brandDeep = "#003D5C";     // deepest shade for option C

    return `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
  <title>Your Personalised RA Optimisation Plan</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
  <style>
    body,table,td,p,a,li{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
    table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}
    img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none}
    body{margin:0;padding:0;width:100%!important;-webkit-font-smoothing:antialiased}
    @media only screen and (max-width:620px){
      .email-container{width:100%!important;max-width:100%!important}
      .option-card{display:block!important;width:100%!important}
      .stat-box{display:block!important;width:100%!important;margin-bottom:8px!important}
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:'Segoe UI',Arial,sans-serif;">
  <!--[if mso]><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f0f2f5"><tr><td align="center"><![endif]-->
  <div style="background-color:#f0f2f5;padding:20px 0;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" width="100%" style="max-width:640px;margin:0 auto;" class="email-container">

      <!-- HEADER -->
      <tr>
        <td style="background-color:${brand};background-image:linear-gradient(135deg,${brand} 0%,${brandDark} 100%);padding:32px 32px 24px;border-radius:12px 12px 0 0;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td style="padding-bottom:16px;">
                ${logoUrl
                    ? `<img src="${logoUrl}" alt="TTT Group" width="140" style="display:block;border:0;outline:none;text-decoration:none;max-width:140px;height:auto;">`
                    : `<span style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;font-weight:600;letter-spacing:1.5px;color:rgba(255,255,255,0.7);text-transform:uppercase;">TTT GROUP</span>`}
              </td>
            </tr>
            <tr>
              <td style="font-family:'Segoe UI',Arial,sans-serif;font-size:26px;font-weight:700;color:#ffffff;line-height:1.3;padding-bottom:8px;">
                Your Personalised Tax Optimisation Plan
              </td>
            </tr>
            <tr>
          
            </tr>
          </table>
        </td>
      </tr>

      <!-- GREETING + INTRO -->
      <tr>
        <td style="background-color:#ffffff;padding:28px 32px 20px;">
          <p style="margin:0 0 20px;font-family:'Segoe UI',Arial,sans-serif;font-size:16px;color:#1a202c;line-height:1.6;">
            ${copy.greeting}
          </p>
          <p style="margin:0 0 16px;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;color:#4a5568;line-height:1.7;">
            The new ${targetYear} tax year has just begun &mdash; which means you now have a full year of opportunity to structure your finances strategically and reduce your tax burden.
          </p>
          <p style="margin:0 0 16px;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;color:#4a5568;line-height:1.7;">
            At TTT Financial Group, we don&rsquo;t believe in reactive tax planning. We believe in using every available mechanism to legally minimise tax and accelerate long-term wealth creation.
          </p>
          <p style="margin:0 0 16px;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;color:#4a5568;line-height:1.7;">
            Using the figures below from your most recent tax return, I&rsquo;ve prepared three tailored retirement annuity scenarios for you. For many clients, the outcome is compelling &mdash; redirecting money that would have gone to tax into a growing retirement asset instead.
          </p>

        </td>
      </tr>

      <!-- DIVIDER -->
      <tr><td style="background-color:#ffffff;padding:0 32px;"><div style="border-top:1px solid #e2e8f0;"></div></td></tr>

      <!-- OPTIONS A + B side by side -->
      <tr>
        <td style="background-color:#ffffff;padding:24px 32px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <!-- OPTION A -->
              <td class="option-card" width="50%" style="vertical-align:top;padding-right:8px;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border:2px solid ${brand};border-radius:12px;overflow:hidden;">
                  <tr>
                    <td style="background-color:${brand};padding:12px 16px;">
                      <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:10px;font-weight:600;letter-spacing:1px;color:rgba(255,255,255,0.8);text-transform:uppercase;">OPTION A</div>
                      <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;padding-top:2px;">Moderate Top-Up</div>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:14px;">
                      <div style="background-color:${brandLight};border-radius:8px;padding:10px 12px;text-align:center;margin-bottom:8px;">
                        <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:10px;color:${brandDark};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">Contribute / month</div>
                        <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:18px;font-weight:700;color:${brand};">${fmt(optionA.monthlyAdditionalRa)}</div>
                      </div>
                      <div style="background-color:${brandLight};border-radius:8px;padding:10px 12px;text-align:center;margin-bottom:8px;">
                        <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:10px;color:${brandDark};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">Tax Saving / year</div>
                        <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:18px;font-weight:700;color:${brand};">${fmt(optionA.taxSaving)}</div>
                      </div>
                      ${rp ? `<div style="background-color:#ECFDF5;border:1px solid #A7F3D0;border-radius:8px;padding:10px 12px;text-align:center;">
                        <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:10px;color:#047857;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">Extra at 65 (${rp.yearsToRetirement}yrs @ 10%)</div>
                        <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:18px;font-weight:700;color:#065F46;">${fmt(rp.projectedValueA)}</div>
                      </div>` : ""}
                    </td>
                  </tr>
                </table>
              </td>
              <!-- OPTION B -->
              <td class="option-card" width="50%" style="vertical-align:top;padding-left:8px;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border:2px solid ${brandDark};border-radius:12px;overflow:hidden;">
                  <tr>
                    <td style="background-color:${brandDark};padding:12px 16px;">
                      <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:10px;font-weight:600;letter-spacing:1px;color:rgba(255,255,255,0.8);text-transform:uppercase;">OPTION B</div>
                      <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;padding-top:2px;">Accelerated Growth</div>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:14px;">
                      <div style="background-color:${brandLight};border-radius:8px;padding:10px 12px;text-align:center;margin-bottom:8px;">
                        <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:10px;color:${brandDark};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">Contribute / month</div>
                        <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:18px;font-weight:700;color:${brandDark};">${fmt(optionB.monthlyAdditionalRa)}</div>
                      </div>
                      <div style="background-color:${brandLight};border-radius:8px;padding:10px 12px;text-align:center;margin-bottom:8px;">
                        <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:10px;color:${brandDark};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">Tax Saving / year</div>
                        <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:18px;font-weight:700;color:${brandDark};">${fmt(optionB.taxSaving)}</div>
                      </div>
                      ${rp ? `<div style="background-color:#ECFDF5;border:1px solid #A7F3D0;border-radius:8px;padding:10px 12px;text-align:center;">
                        <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:10px;color:#047857;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">Extra at 65 (${rp.yearsToRetirement}yrs @ 10%)</div>
                        <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:18px;font-weight:700;color:#065F46;">${fmt(rp.projectedValueB)}</div>
                      </div>` : ""}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- OPTION C -->
      <tr>
        <td style="background-color:#ffffff;padding:0 32px 28px;padding-top:0;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border:2px solid ${brandDeep};border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background-color:${brandDarker};background-image:linear-gradient(135deg,${brandDarker} 0%,${brandDeep} 100%);padding:14px 20px;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                  <tr>
                    <td style="font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:1px;color:rgba(255,255,255,0.8);text-transform:uppercase;">OPTION C &bull; RECOMMENDED</td>
                  </tr>
                  <tr>
                    <td style="font-family:'Segoe UI',Arial,sans-serif;font-size:18px;font-weight:700;color:#ffffff;padding-top:2px;">Personalised Plan</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:20px;">
                <div style="background-color:${brandLight};border-radius:8px;padding:18px 20px;text-align:center;margin-bottom:16px;">
                  <p style="margin:0;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;color:${brandDeep};line-height:1.6;font-weight:600;">
                    Let TTT find the perfect plan tailored to your unique financial situation. Our advisors will work with you to maximise your tax savings and retirement growth.
                  </p>
                </div>
                <!-- CTA Button -->
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"${rp ? "" : ` style="margin-top:16px;"`}>
                  <tr>
                    <td align="center">
                      <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="tel:+27100001234" style="height:48px;v-text-anchor:middle;width:100%;" arcsize="12%" strokecolor="${brandDeep}" fillcolor="${brandDeep}"><center style="color:#ffffff;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:bold;">Call TTT to Get Started</center></v:roundrect><![endif]-->
                      <!--[if !mso]><!-->
                      <a href="tel:+27100001234" style="display:block;background-color:${brandDarker};background-image:linear-gradient(135deg,${brandDarker} 0%,${brandDeep} 100%);color:#ffffff;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;text-align:center;padding:14px 24px;border-radius:8px;">
                        Call TTT to Get Started &rarr;
                      </a>
                      <!--<![endif]-->
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- CLOSING -->
      <tr>
        <td style="background-color:#ffffff;padding:0 32px 28px;">
          <p style="margin:0;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;color:#4a5568;line-height:1.6;">
            ${copy.closingText}
          </p>
        </td>
      </tr>

      <!-- DISCLAIMER + FOOTER -->
      <tr>
        <td style="background-color:#f7fafc;padding:20px 32px;border-top:1px solid #e2e8f0;border-radius:0 0 12px 12px;">
          <p style="margin:0 0 8px;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:#a0aec0;line-height:1.5;">
            <strong>Disclaimer:</strong> This email is for informational purposes only and does not constitute financial advice. Tax calculations are estimates based on your ${yearOfAssessment} assessment data and current SA tax tables, prepared to help you optimise your financial position heading into ${targetYear}. Please consult with a TTT advisor for personalised financial planning.
          </p>
          <p style="margin:0;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:#a0aec0;text-align:center;">
            &copy; ${new Date().getFullYear()} TTT Group. All rights reserved.
          </p>
        </td>
      </tr>

    </table>
  </div>
  <!--[if mso]></td></tr></table><![endif]-->
</body>
</html>`.trim();
}
