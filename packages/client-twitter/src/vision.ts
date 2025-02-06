import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

// Initialize Anthropic client
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
});

// Function to encode an image to base64
function encodeImageToBase64(imagePath: string): string {
    const imageBuffer = fs.readFileSync(imagePath);
    return imageBuffer.toString('base64');
}

export async function describeImage(imagePath: string, prompt: string): Promise<string | null> {
    const imageBase64 = encodeImageToBase64(imagePath);

    try {
        const response = await anthropic.messages.create({
            model: 'claude-3-opus-20240229',
            max_tokens: 1024,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: 'image/jpeg',
                                data: imageBase64,
                            },
                        },
                    ],
                },
            ],
        });

        // Check if response contains text-based content
        const textResponse = response.content
            .filter((block: any) => block.type === 'text') // Only keep text blocks
            .map((block: any) => block.text) // Extract text values
            .join('\n'); // Join multiple text blocks

        return textResponse || null;
    } catch (error) {
        console.error('Claude Vision API Error:', error);
        return null;
    }
}

