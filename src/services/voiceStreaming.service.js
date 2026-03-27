import OpenAI from "openai";
import { createClient } from "@deepgram/sdk";
import { getRelevantContext } from "./rag.service.js";
import { checkTokenLimit, trackTokenUsage } from "./tokenTracking.service.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// ============================================
// Fast Streaming Voice Response
// ============================================
export async function streamVoiceResponse(extensionId, agentId, userMessage, agent) {
  try {
    // 1. Quick token check
    const tokenCheck = await checkTokenLimit(extensionId, "chatgpt", userMessage, agent.modelName);
    if (!tokenCheck.allowed) {
      throw new Error(`Token limit: ${tokenCheck.reason}`);
    }

    // 2. Get RAG context (parallel with token check)
    const contextPromise = getRelevantContext(agentId, userMessage, 1500);
    const context = await contextPromise;

    // 3. Build optimized prompt
    const systemPrompt = buildSystemPrompt(agent, context);

    // 4. Stream response with minimal latency
    const stream = await openai.chat.completions.create({
      model: agent.modelName || "gpt-4o-mini", // Use mini for speed
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      max_tokens: Math.min(tokenCheck.tokens, 500), // Limit for faster response
      temperature: 0.7,
      stream: true,
      stream_options: { include_usage: true }
    });

    return {
      stream,
      trackUsage: async (tokensUsed) => {
        await trackTokenUsage(extensionId, "chatgpt", tokensUsed);
      }
    };

  } catch (error) {
    console.error("Stream voice error:", error);
    throw error;
  }
}

// ============================================
// Fast Deepgram Transcription (Real-time)
// ============================================
export function createDeepgramStream(extensionId, onTranscript, onError) {
  try {
    const connection = deepgram.listen.live({
      model: "nova-2",
      language: "en",
      smart_format: true,
      interim_results: false, // Only final results for speed
      endpointing: 300, // Quick endpointing (300ms)
      vad_events: true,
    });

    connection.on("open", () => {
      console.log("Deepgram connection opened");
    });

    connection.on("Results", async (data) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (transcript && transcript.trim()) {
        onTranscript(transcript);
        
        // Track usage
        const estimatedTokens = Math.ceil(transcript.length / 4);
        await trackTokenUsage(extensionId, "deepgram", estimatedTokens);
      }
    });

    connection.on("error", (error) => {
      console.error("Deepgram error:", error);
      onError(error);
    });

    connection.on("close", () => {
      console.log("Deepgram connection closed");
    });

    return connection;

  } catch (error) {
    console.error("Deepgram stream error:", error);
    throw error;
  }
}

// ============================================
// Optimized TTS Streaming
// ============================================
export async function streamTextToSpeech(text, voice = "alloy") {
  try {
    const response = await openai.audio.speech.create({
      model: "tts-1", // Faster model
      voice: voice,
      input: text,
      response_format: "opus", // Better for streaming
      speed: 1.1, // Slightly faster for responsiveness
    });

    return response.body;

  } catch (error) {
    console.error("TTS stream error:", error);
    throw error;
  }
}

// ============================================
// Helper: Build System Prompt
// ============================================
function buildSystemPrompt(agent, context) {
  let prompt = agent.systemPrompt || "You are a helpful voice assistant.";
  
  if (context) {
    prompt += `\n\nContext:\n${context}\n\nUse the context above to answer questions accurately.`;
  }

  // Add voice-specific instructions
  prompt += "\n\nIMPORTANT: Keep responses concise and natural for voice conversation. Avoid long explanations.";

  return prompt;
}

// ============================================
// Complete Voice Call Handler (Optimized)
// ============================================
export async function handleOptimizedVoiceCall(extensionId, agentId, audioChunk, agent) {
  const startTime = Date.now();
  
  try {
    // 1. Fast transcription
    const transcriptStart = Date.now();
    const { result } = await deepgram.listen.prerecorded.transcribeFile(
      audioChunk,
      {
        model: "nova-2",
        smart_format: true,
        language: "en"
      }
    );
    const transcript = result.results.channels[0].alternatives[0].transcript;
    console.log(`Transcription: ${Date.now() - transcriptStart}ms`);

    if (!transcript || transcript.trim().length === 0) {
      return null;
    }

    // 2. Stream AI response
    const aiStart = Date.now();
    const { stream, trackUsage } = await streamVoiceResponse(
      extensionId, 
      agentId, 
      transcript, 
      agent
    );

    let fullResponse = "";
    let tokensUsed = 0;

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
      fullResponse += content;
      
      // Track usage from final chunk
      if (chunk.usage) {
        tokensUsed = chunk.usage.total_tokens;
      }
    }

    console.log(`AI Response: ${Date.now() - aiStart}ms`);

    // 3. Track usage
    if (tokensUsed > 0) {
      await trackUsage(tokensUsed);
    }

    const totalTime = Date.now() - startTime;
    console.log(`Total processing: ${totalTime}ms`);

    return {
      transcript,
      response: fullResponse,
      processingTime: totalTime
    };

  } catch (error) {
    console.error("Optimized voice call error:", error);
    throw error;
  }
}
