import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

// Helper function to update source status
async function updateSourceStatus(sourceId: string, status: string, errorMessage?: string) {
  const supabaseClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  const updateData: any = { processing_status: status }
  if (errorMessage) {
    updateData.metadata = { error: errorMessage }
  }

  await supabaseClient
    .from('sources')
    .update(updateData)
    .eq('id', sourceId)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { sourceId, filePath, sourceType } = await req.json()

    if (!sourceId || !filePath || !sourceType) {
      return new Response(
        JSON.stringify({ error: 'sourceId, filePath, and sourceType are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Processing document:', { source_id: sourceId, file_path: filePath, source_type: sourceType });

    // Get environment variables
    const webhookUrl = Deno.env.get('DOCUMENT_PROCESSING_WEBHOOK_URL')
    const authHeader = Deno.env.get('NOTEBOOK_GENERATION_AUTH')

    if (!webhookUrl) {
      console.error('Missing DOCUMENT_PROCESSING_WEBHOOK_URL environment variable')
      const errorMessage = 'Document processing webhook URL not configured. Please set DOCUMENT_PROCESSING_WEBHOOK_URL in Supabase Edge Function secrets.'
      
      await updateSourceStatus(sourceId, 'failed', errorMessage)

      return new Response(
        JSON.stringify({ error: errorMessage }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validate webhook URL format
    if (!isValidUrl(webhookUrl)) {
      console.error('Invalid DOCUMENT_PROCESSING_WEBHOOK_URL format:', webhookUrl)
      const errorMessage = `Invalid webhook URL format: ${webhookUrl}. Please ensure the URL includes the protocol (https://) and is properly formatted.`
      
      await updateSourceStatus(sourceId, 'failed', errorMessage)

      return new Response(
        JSON.stringify({ error: errorMessage }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Calling external webhook:', webhookUrl);

    // Create the file URL for public access
    const fileUrl = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/sources/${filePath}`

    // Prepare the payload for the webhook with correct variable names
    const payload = {
      source_id: sourceId,
      file_url: fileUrl,
      file_path: filePath,
      source_type: sourceType,
      callback_url: `${Deno.env.get('SUPABASE_URL')}/functions/v1/process-document-callback`
    }

    console.log('Webhook payload:', payload);

    // Call external webhook with proper headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (authHeader) {
      headers['Authorization'] = authHeader
    }

    let response;
    try {
      response = await fetch(webhookUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload)
      })
    } catch (fetchError) {
      console.error('Network error calling webhook:', fetchError);
      const errorMessage = `Failed to connect to webhook URL: ${webhookUrl}. Please verify the URL is correct and accessible.`
      
      await updateSourceStatus(sourceId, 'failed', errorMessage)

      return new Response(
        JSON.stringify({ 
          error: 'Document processing failed', 
          details: errorMessage,
          webhookUrl: webhookUrl 
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Webhook call failed:', response.status, response.statusText, errorText);
      
      const errorMessage = `Webhook returned ${response.status} ${response.statusText}: ${errorText}`
      await updateSourceStatus(sourceId, 'failed', errorMessage)

      return new Response(
        JSON.stringify({ 
          error: 'Document processing failed', 
          details: errorMessage,
          webhookUrl: webhookUrl,
          status: response.status,
          statusText: response.statusText
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const result = await response.json()
    console.log('Webhook response:', result);

    return new Response(
      JSON.stringify({ success: true, message: 'Document processing initiated', result }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Error in process-document function:', error)
    
    // Try to update source status if we have the sourceId
    try {
      const { sourceId } = await req.clone().json()
      if (sourceId) {
        await updateSourceStatus(sourceId, 'failed', 'Internal server error during document processing')
      }
    } catch (parseError) {
      console.error('Could not parse request to update source status:', parseError)
    }

    return new Response(
      JSON.stringify({ error: 'Internal server error', details: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})