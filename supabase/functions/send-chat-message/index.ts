import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Helper function to validate URL format
function isValidUrl(string: string): boolean {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { session_id, message, user_id } = await req.json();
    
    console.log('Received message:', { session_id, message, user_id });

    // Get the webhook URL and auth header from environment
    const webhookUrl = Deno.env.get('NOTEBOOK_CHAT_URL');
    const authHeader = Deno.env.get('NOTEBOOK_GENERATION_AUTH');
    
    if (!webhookUrl) {
      const errorMessage = 'NOTEBOOK_CHAT_URL environment variable not set. Please configure this secret in Supabase Edge Functions.';
      console.error(errorMessage);
      throw new Error(errorMessage);
    }

    if (!authHeader) {
      const errorMessage = 'NOTEBOOK_GENERATION_AUTH environment variable not set. Please configure this secret in Supabase Edge Functions.';
      console.error(errorMessage);
      throw new Error(errorMessage);
    }

    // Validate webhook URL format
    if (!isValidUrl(webhookUrl)) {
      const errorMessage = `Invalid NOTEBOOK_CHAT_URL format: ${webhookUrl}. Please ensure the URL includes the protocol (https://) and is properly formatted.`;
      console.error(errorMessage);
      throw new Error(errorMessage);
    }

    console.log('Sending to webhook URL:', webhookUrl);
    console.log('Using auth header (first 10 chars):', authHeader.substring(0, 10) + '...');

    // Prepare the payload
    const payload = {
      session_id,
      message,
      user_id,
      timestamp: new Date().toISOString()
    };

    console.log('Webhook payload:', payload);

    let webhookResponse;
    try {
      // Send message to n8n webhook with authentication
      webhookResponse = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
        },
        body: JSON.stringify(payload)
      });
    } catch (fetchError) {
      const errorMessage = `Failed to connect to webhook URL: ${webhookUrl}. Network error: ${fetchError.message}`;
      console.error(errorMessage);
      throw new Error(errorMessage);
    }

    console.log('Webhook response status:', webhookResponse.status);
    console.log('Webhook response headers:', Object.fromEntries(webhookResponse.headers.entries()));

    if (!webhookResponse.ok) {
      const errorText = await webhookResponse.text();
      const errorMessage = `Webhook responded with status: ${webhookResponse.status} ${webhookResponse.statusText}. Response: ${errorText}`;
      console.error(errorMessage);
      console.error('Full webhook URL used:', webhookUrl);
      
      throw new Error(errorMessage);
    }

    let webhookData;
    try {
      webhookData = await webhookResponse.json();
    } catch (parseError) {
      const responseText = await webhookResponse.text();
      console.log('Webhook returned non-JSON response:', responseText);
      webhookData = { message: 'Webhook processed successfully', response: responseText };
    }

    console.log('Webhook response data:', webhookData);

    return new Response(
      JSON.stringify({ success: true, data: webhookData }),
      { 
        headers: { 
          ...corsHeaders,
          'Content-Type': 'application/json' 
        } 
      }
    );

  } catch (error) {
    console.error('Error in send-chat-message:', error);
    
    return new Response(
      JSON.stringify({ 
        error: error.message || 'Failed to send message to webhook',
        details: {
          webhookUrl: Deno.env.get('NOTEBOOK_CHAT_URL'),
          hasAuth: !!Deno.env.get('NOTEBOOK_GENERATION_AUTH'),
          timestamp: new Date().toISOString()
        }
      }),
      { 
        status: 500,
        headers: { 
          ...corsHeaders,
          'Content-Type': 'application/json' 
        }
      }
    );
  }
});