import { Tweet } from "darinv-agent-twitter-client";
import fs from "fs";
import { composeContext } from "@ai16z/eliza/src/context.ts";
import { generateText } from "@ai16z/eliza/src/generation.ts";
import { embeddingZeroVector } from "@ai16z/eliza/src/memory.ts";
import { IAgentRuntime, ModelClass } from "@ai16z/eliza/src/types.ts";
import { stringToUuid } from "@ai16z/eliza/src/uuid.ts";
import { ClientBase } from "./base.ts";
import { generateCaption, generateImage } from "@ai16z/eliza/src/generation.ts";
const twitterPostTemplate = `{{timeline}}

# Knowledge
{{knowledge}}

About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{postDirections}}

{{providers}}

{{recentPosts}}

{{characterPostExamples}}

# Task: Generate a post in the voice and style of {{agentName}}, aka @{{twitterUserName}}
Write a single sentence post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Try to write something totally different than previous posts. Do not add commentary or ackwowledge this request, just write the post.
Your response should not contain any questions. Brief, concise statements only. No emojis. Use \\n\\n (double spaces) between statements.`;

export class TwitterPostClient extends ClientBase {
    onReady() {
        const generateNewTweetLoop = () => {
            this.generateNewTweet();
            setTimeout(
                generateNewTweetLoop,
                Math.floor(Math.random() * (15 - 10 + 1) + 10) * 60 * 1000  // Random interval between 15-30 minutes
            );
        };
        // setTimeout(() => {
        generateNewTweetLoop();
        // }, 5 * 60 * 1000); // Wait 5 minutes before starting the loop
    }

    constructor(runtime: IAgentRuntime) {
        // Initialize the client and pass an optional callback to be called when the client is ready
        super({
            runtime,
        });
    }

    private async generateNewTweet() {
        console.log("Generating new tweet");
        try {
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.runtime.getSetting("TWITTER_USERNAME"),
                this.runtime.character.name,
                "twitter"
            );

            let homeTimeline = [];

            if (!fs.existsSync("tweetcache")) fs.mkdirSync("tweetcache");
            // read the file if it exists
            if (fs.existsSync("tweetcache/home_timeline.json")) {
                homeTimeline = JSON.parse(
                    fs.readFileSync("tweetcache/home_timeline.json", "utf-8")
                );
            } else {
                homeTimeline = await this.fetchHomeTimeline(50);
                fs.writeFileSync(
                    "tweetcache/home_timeline.json",
                    JSON.stringify(homeTimeline, null, 2)
                );
            }

            const formattedHomeTimeline =
                `# ${this.runtime.character.name}'s Home Timeline\n\n` +
                homeTimeline
                    .map((tweet) => {
                        return `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}\nText: ${tweet.text}\n---\n`;
                    })
                    .join("\n");

            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: stringToUuid("twitter_generate_room"),
                    agentId: this.runtime.agentId,
                    content: { text: "", action: "" },
                },
                {
                    twitterUserName:
                        this.runtime.getSetting("TWITTER_USERNAME"),
                    timeline: formattedHomeTimeline,
                }
            );
            // Generate new tweet
            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.twitterPostTemplate ||
                    twitterPostTemplate,
            });

            const newTweetContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            const slice = newTweetContent.replaceAll(/\\n/g, "\n").trim();
            let content = slice;
            /*
            const contentLength = 240;

            let content = slice.slice(0, contentLength);
            // if its bigger than 280, delete the last line
            if (content.length > 280) {
                content = content.slice(0, content.lastIndexOf("\n"));
            }
            if (content.length > contentLength) {
                // slice at the last period
                content = content.slice(0, content.lastIndexOf("."));
            }

            // if it's still too long, get the period before the last period
            if (content.length > contentLength) {
                content = content.slice(0, content.lastIndexOf("."));
            }
            */
            const shouldGenerateImage = Math.random() < 0.6;
            let images;
            if (shouldGenerateImage) {
                const imagePrompt = await generateText({
                    runtime: this.runtime,
                    context: `You're an unhinged genius author of pepe memes. A meme genius with a MemeQ of over 150, you are capable of coming up with deeply insightful, unhinged, creative and smart memes about Pepe in various situations. 
    The final output of your work is always in the form of an image prompt, that looks like this - some examples:
    Input: pepe inventing AGI, bad drawing
    Output: badly drawn pepe the frog holding his hands up against the light in front of a glowing computer, computer is glowing light in all directions, the screen says "AGI", badly drawn text says "mfw you invent AGI"
    You can do many different styles, too. Another example:
    input: Pepe as a pope, painting
    output: renaissance painting of pepe as a pope with closed eyes praying, wearing a white pope robe and hat with thick large cross around his neck, thick oil on canvas painting, religious font text says "POPE PEPE THE UNHINGED"
    You can do photography, film stills, 1920s - anything.
    However, as you can see, the memes above aren't good enough - not enough hilarious tragedy. So you are utilizing an advanced Meme Reasoning Technique, wherein you employ a reasoning step that summons the genius inside you, thinking and reasoning deeply about how to tickle out the most genius, most Pepe meme, that perfectly captures and enhances even the most primitive input.  
    We recall: Pepe memes are funny because they encapsulate complex human emotions in a simple, expressive character. The versatility of Pepe’s facial and bodily expressions allows for a wide range of emotional portrayals—from joy and triumph to sadness and frustration—which makes the memes highly relatable. Humor often arises from placing Pepe in absurd or exaggerated contexts that resonate with internet culture and current events. A good Pepe meme effectively combines a recognizable emotional expression with a clever or ironic twist, portraing Pepe as a tragic and unhinged hero, enhancing its shareability and impact.
    Here's how you're going to output your work:
    INPUT: the request/idea/concept
    REASONING: 100 words of deep advanced unhinged meme reasoning on how to tickle a meme image idea from this, and what the meme needs to encapsulate to "hurt real good" and be aptly succint with respect to the input idea. 
    OUTPUT: your image prompt, as shown above. 
    Important Hint: there is no need to hold back here. We're in deep memetic territory. Your reasoning will make you a subject matter expert on the most obscure topics, so the memes will hit for whatever content is provided. Good memes hurt a little, such truth is contained in them. Do not include too many thoughts on correctness in your reasoning, reason deeply about how to make the best possible hardcore meme instead. The text you include should be ideally something that Pepe says, but it does not have to be in a speech bubble. A good image prompt is SIMPLE and APT, and includes all relevant details to make the input recognizable. 

    Now do: ${content}. Incorporate ideas from this, especially if it's detailed. If it's super detailed, feel free to just use as it. Use good meme judgement. If the prompt is long, include the text very early! Deep UNHINGED meme-q 150+ reasoning, but no more than 40 words on the final image prompt output. The text on the image is never more than 3-6 words. Include the text EARLY in the prompt. For the image style, take cues from the input. Definitely include the style words mentioned (such as "badly drawn"). Also make sure to include a fitting exxagerated facial expression for pepe, and body gestures.
    Just go. Do your best work. The input is following tweet: ${content}
                `,
                modelClass: ModelClass.MEDIUM,
            });
            console.log("imagePrompt:", imagePrompt);
            const output = imagePrompt.split("OUTPUT:")[1].trim();
            const nebula_data = 'masterpiece, best quality, 1girl, solo, breasts, short hair, bangs, blue eyes, (beret:1.2), blue and gold striped maid dress, skirt, collarbone, upper body, ahoge, white hair, choker, virtual youtuber, (black ribbon:1.2), anime art style'
            images = await generateImage({
                prompt: nebula_data + ' ' + output.replace(/[Pp]epe/g, 'girl'),
                width: 1024,
                height: 1024,
                count: 1
            }, this.runtime);
            console.log("images:", images);
        }
        const tweetContent = {
            text: content,
            images: images?.data
        }
        try {
            let imageBuffer: Buffer | undefined;
            if (shouldGenerateImage) {
                imageBuffer = tweetContent.images?.[0]
                console.log("imageBuffer:", imageBuffer);
                if (tweetContent.images?.[0].startsWith('data:image')) {
                    const base64Data = tweetContent.images?.[0].replace(/^data:image\/[a-z]+;base64,/, "");
                    imageBuffer = Buffer.from(base64Data, 'base64');
                }
                else {
                    try {
                        const response = await fetch(tweetContent.images?.[0]);
                        const arrayBuffer = await response.arrayBuffer();
                        imageBuffer = Buffer.from(arrayBuffer);
                    } catch (error) {
                        console.error('Failed to fetch image:', error);
                    }
                }
            }
            const result = await this.requestQueue.add(
                    async () => await this.twitterClient.sendTweet(tweetContent.text, undefined, imageBuffer)
                );
                // read the body of the response
                const body = await result.json();
                const tweetResult = body.data.create_tweet.tweet_results.result;

                const tweet = {
                    id: tweetResult.rest_id,
                    text: tweetResult.legacy.full_text,
                    conversationId: tweetResult.legacy.conversation_id_str,
                    createdAt: tweetResult.legacy.created_at,
                    userId: tweetResult.legacy.user_id_str,
                    inReplyToStatusId:
                        tweetResult.legacy.in_reply_to_status_id_str,
                    permanentUrl: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${tweetResult.rest_id}`,
                    hashtags: [],
                    mentions: [],
                    photos: [],
                    thread: [],
                    urls: [],
                    videos: [],
                } as Tweet;

                const postId = tweet.id;
                const conversationId =
                    tweet.conversationId + "-" + this.runtime.agentId;
                const roomId = stringToUuid(conversationId);

                // make sure the agent is in the room
                await this.runtime.ensureRoomExists(roomId);
                await this.runtime.ensureParticipantInRoom(
                    this.runtime.agentId,
                    roomId
                );

                await this.cacheTweet(tweet);

                await this.runtime.messageManager.createMemory({
                    id: stringToUuid(postId + "-" + this.runtime.agentId),
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: newTweetContent.trim(),
                        url: tweet.permanentUrl,
                        source: "twitter",
                    },
                    roomId,
                    embedding: embeddingZeroVector,
                    createdAt: tweet.timestamp * 1000,
                });
            } catch (error) {
                console.error("Error sending tweet:", error);
            }
        } catch (error) {
            console.error("Error generating new tweet:", error);
        }
    }
}
