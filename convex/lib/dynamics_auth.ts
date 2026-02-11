/**
 * Dynamics 365 Authentication using Service Principal (Client Credentials)
 * Uses Azure AD to obtain access token for Dynamics 365 Web API
 */

interface TokenResponse {
    access_token: string;
    expires_in: number;
    token_type: string;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Get an access token for Dynamics 365 using client credentials flow
 */
export async function getDynamicsAccessToken(): Promise<string> {
    const tenantId = process.env.AZURE_TENANT_ID;
    const clientId = process.env.AZURE_CLIENT_ID;
    const clientSecret = process.env.AZURE_CLIENT_SECRET;
    const dynamicsUrl = process.env.DYNAMICS_ORG_URL;

    if (!tenantId || !clientId || !clientSecret || !dynamicsUrl) {
        throw new Error(
            "Missing required environment variables: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, DYNAMICS_ORG_URL"
        );
    }

    // Check if we have a valid cached token (with 5-minute buffer)
    if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) {
        return cachedToken.token;
    }

    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

    const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: `${dynamicsUrl}/.default`,
        grant_type: "client_credentials",
    });

    const response = await fetch(tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to acquire Dynamics token: ${response.status} - ${errorText}`);
    }

    const data: TokenResponse = await response.json();

    // Cache the token
    cachedToken = {
        token: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1000,
    };

    return data.access_token;
}

/**
 * Make an authenticated request to Dynamics 365 Web API
 */
export async function dynamicsRequest<T>(
    endpoint: string,
    options: RequestInit = {}
): Promise<T> {
    const dynamicsUrl = process.env.DYNAMICS_ORG_URL;
    if (!dynamicsUrl) {
        throw new Error("DYNAMICS_ORG_URL is not configured");
    }

    const token = await getDynamicsAccessToken();
    const url = `${dynamicsUrl}/api/data/v9.2/${endpoint}`;

    const response = await fetch(url, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
            Accept: "application/json",
            "Content-Type": "application/json",
            Prefer: 'odata.include-annotations="*"',
            ...options.headers,
        },
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Dynamics API error: ${response.status} - ${errorText}`);
    }

    // 204 No Content (e.g. successful PATCH) has no body to parse
    if (response.status === 204) {
        return {} as T;
    }

    return response.json();
}
