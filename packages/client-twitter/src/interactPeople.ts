import { IAgentRuntime, Content, HandlerCallback, State, ModelClass, ServiceType, IImageDescriptionService } from "@ai16z/eliza/src/types.ts";
import { stringToUuid } from "@ai16z/eliza/src/uuid.ts";
import fs from "fs";
import { composeContext } from "@ai16z/eliza/src/context.ts";
import { wait, sendTweet, buildConversationThread } from "./utils.ts"; // Adjust the import path as necessary
import { generateImage, generateMessageResponse, generateText } from "@ai16z/eliza/src/generation.ts";
import { ClientBase } from "./base.ts";
import { messageCompletionFooter } from "@ai16z/eliza/src/parsing.ts";
import { characterJsonManager } from "@ai16z/eliza/src/characterJsonManager.ts";
import {Browser} from 'puppeteer';
import puppeteer from 'puppeteer';
import path from 'path';
import {
    QueryTweetsResponse,
    Scraper,
    SearchMode,
    Tweet,
} from "darinv-agent-twitter-client";
import { embeddingZeroVector } from "@ai16z/eliza";
import axios from "axios";
import { describeImage } from "./vision.ts";

interface Transaction {
    token: string;
    boughtToken: string;
    amount: number;
    marketCap: number;
}

interface Post {
    text_content: string;
    post_id: string;
    owner: {
        nickname: string;
        avatar_url: string;
    };
    // Add other fields if needed
}

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

{{mostPurchasedTokenData}}

{{relatedTweets}}

# Task: This is the information about a token's buy order, and the top tweets about the token in the last hour. Come up with a tweet justifying the big buy order. Write a small paragraph, no bullet points, and talk like a crypto degen. Don't ask people to buy or sell, just give your unbiased opinion and information.`;

const twitterSearchTemplate =
    `{{timeline}}

    {{providers}}

    Recent interactions between {{agentName}} and other users:
    {{recentPostInteractions}}

    About {{agentName}} (@{{twitterUserName}}):
    {{bio}}
    {{lore}}
    {{topics}}

    {{postDirections}}

    {{recentPosts}}

    # Task: Respond to the following post in the style and perspective of {{agentName}} (aka @{{twitterUserName}}). Write a {{adjective}} response for {{agentName}} to say directly in response to the post. don't generalize.
    {{currentPost}}

    IMPORTANT: Your response CANNOT be longer than 20 words.
    Your response CANNOT be longer than 250 characters.
    Aim for 1-2 short sentences maximum. Be concise and direct.

    Your response should not contain any questions. Brief, concise statements only. No emojis. Use \\n\\n (double spaces) between statements.

    ` + messageCompletionFooter;

const COINMARKETCAP_API_URL = "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/historical";

export class TwitterInteractPeopleClient extends ClientBase {
    private respondedTweets: Set<string> = new Set();
    private checkInterval: NodeJS.Timeout | null = null;
    private usernames: string[];
    private currentResponseIndex: number = 0;
    private currentPostIndex: number = 0;

    constructor(runtime: IAgentRuntime) {
        super({ runtime });
        this.usernames = this.loadUsernames();
    }

    private loadUsernames(): string[] {
        // Check if character's people array exists and is not empty
        if (!this.runtime.character.people || this.runtime.character.people.length === 0) {
            console.warn("No usernames found in character's people array.");
            return []; // Return an empty array if no usernames are available
        }
        // Load usernames from the character's people array
        return [...this.runtime.character.people];
    }

    async onReady() {
        if (!this.checkInterval && this.usernames.length > 0) {
            this.checkForNewTweetsLoop();
        }
    }

    private checkForNewTweetsLoop() {
        this.checkForNewTweets().then(() => {
            // Set a random interval between 5 to 10 minutes
            const randomInterval = Math.floor(Math.random() * (10 - 5 + 1) + 5) * 60 * 1000;
            this.checkInterval = setTimeout(() => this.checkForNewTweetsLoop(), randomInterval);
        }).catch(error => {
            console.error("Error in checkForNewTweetsLoop:", error);
        });
    }

    private async wsEndPoint() {
        return await fetch('http://127.0.0.1:9222/json/version')
            .then((res) => res.json())
            .then((res) => res.webSocketDebuggerUrl)
    }

    private async takeScreenshot(
        browser: Browser,
        url: string,
        outputPath: string,
        options: {
            fullPage?: boolean;
            width?: number;
            height?: number;
            deviceScaleFactor?: number;
            waitForSelector?: string;
            timeout?: number;
        } = {}
    ) {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const pathInfo = path.parse(outputPath);
            const newFileName = `${pathInfo.name}_${timestamp}${pathInfo.ext}`;
            const fullOutputPath = path.join(pathInfo.dir, newFileName);
            const page = await browser.newPage();

            await page.setViewport({
                width: options.width || 1920,
                height: options.height || 1080,
                deviceScaleFactor: options.deviceScaleFactor || 1
            });

            await page.goto(url, {
                waitUntil: 'networkidle0',
                timeout: options.timeout || 30000
            });

            if (options.waitForSelector) {
                await page.waitForSelector(options.waitForSelector, {
                    timeout: options.timeout || 30000
                });
            }

            // Create directory if it doesn't exist
            await fs.promises.mkdir(pathInfo.dir, { recursive: true });

            await page.screenshot({
                path: fullOutputPath,
                fullPage: options.fullPage || false,
                type: 'jpeg'
            });

            console.log(`Screenshot saved to: ${fullOutputPath}`);
            return fullOutputPath;

        } catch (error) {
            console.error('Error taking screenshot:', error);
            throw error;
        } finally {
        }
    }

    private async generateKaitoUrl(tokenName: string): Promise<string> {
        // Base filter structure
        const filters = [
            {
                "field": "created_at",
                "type": "all",
                "values": ["last_24hrs"]
            },
            {
                "field": "index",
                "type": "all",
                "values": [["Twitter", "Warpcast", "Governance", "Vote", "News", "Twitter_Space", "Podcast", "Conference", "Medium", "Research", "Mirror", "Discord", "Telegram"]]
            },
            {
                "field": "language",
                "values": [["en", "zh", "ko", "others"]],
                "type": "all"
            },
            {
                "field": "crypto_ticker",
                "values": [[`${tokenName}__${tokenName}__${tokenName}__https://kaito-public-assets.s3.us-west-2.amazonaws.com/ticker-icons/${tokenName}/997651cfb21eff430609ba4287ffdb35`]],
                "type": "all"
            }
        ];

        // Create URL parameters
        const params = new URLSearchParams({
            'q': `$${tokenName}`,
            'size': 'n_20_n',
            'filters': JSON.stringify(filters),
            'custom.type': 'News',
            'custom.name': 'NullTX',
            'custom.searchTerm': `$${tokenName}`,
            'custom.tickers': tokenName,
            'custom.trigger': 'Results'
        });

        // Create the final URL
        const baseUrl = 'https://portal.kaito.ai/search';
        const url = `${baseUrl}?${params.toString()}`;

        return url;
    }

    private async getTopToken(text: string): Promise<string> {
        // Find the "Top Gainer" section
        const topGainerIndex = text.indexOf('Top Gainer');
        if (topGainerIndex === -1) return '';

        // Get the text starting from "Top Gainer"
        const relevantText = text.slice(topGainerIndex);

        // Split into lines and find the line after headers
        const lines = relevantText.split('\n');

        // Find the header line (contains "Name Current")
        const headerIndex = lines.findIndex(line => line.includes('Name Current'));
        if (headerIndex === -1) return '';

        // Get the first data line (it's right after the header)
        const topLine = lines[headerIndex + 1];
        if (!topLine) return '';

        // Extract the token name (first word)
        const topToken = topLine.split(' ')[0];

        return topToken;
    }

    private async checkForNewTweets() {

        const browser = await puppeteer.connect({ browserWSEndpoint: await this.wsEndPoint() });

        let pathToScreenshot = await this.takeScreenshot(
            browser,
            'https://portal.kaito.ai/insight',
            'C:\\Users\\Vsevolod\\Desktop\\basic-screenshot.jpeg'
        );

        const description = await describeImage(pathToScreenshot, "Scrape all the text from the image");

        const topToken = await this.getTopToken(description);

        console.log("description: ", description);

        const kaitoUrl = await this.generateKaitoUrl(topToken)

        pathToScreenshot = await this.takeScreenshot(
            browser,
            kaitoUrl,
            'C:\\Users\\Vsevolod\\Desktop\\kaito-screenshot.jpeg'
        );

        return

        if (!fs.existsSync("tweetcache")) {
            fs.mkdirSync("tweetcache"); // Create tweetcache directory if it doesn't exist
        }

        for (const username of this.usernames) {
            try {
                await new Promise((resolve) => setTimeout(resolve, 10000)); // Rate limiting
                const recentTweets = await this.fetchUserTweets(username);

                console.log(recentTweets, "recentTweets----------");

                const formattedHomeTimeline =
                    `# ${this.runtime.character.name}'s Home Timeline\n\n` +
                    recentTweets
                        .map((tweet) => {
                            return `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}\nText: ${tweet.text}\n---\n`;
                        })
                        .join("\n");
                if (recentTweets.length === 0) {
                    console.log(`No tweets found for user: ${username}`);
                    continue; // Skip to the next user if no tweets are found
                }

                let transactions: Transaction[] = []

                for (const tweet of recentTweets) {
                    const transactionData = this.parseTransaction(tweet.text);
                    transactions.push(transactionData);
                }

                const sortedTransactions = transactions.sort((a, b) => b.amount - a.amount);
                console.log("sortedTransactions: ", sortedTransactions);

                const tokenVolumes = transactions.reduce((acc, trans) => {
                    if (!acc[trans.boughtToken] || acc[trans.boughtToken].amount < trans.amount) {
                        acc[trans.boughtToken] = trans;
                    }
                    return acc;
                }, {} as Record<string, Transaction>);

                const mostBoughtToken = Object.entries(tokenVolumes)
                    .sort(([,a], [,b]) => b.amount - a.amount)[0]?.[1];

                if (mostBoughtToken) {

                }

                // Save recent tweets to cache
                fs.writeFileSync("tweetcache/home_timeline.json", JSON.stringify(recentTweets, null, 2));
            } catch (error) {
                console.error(`Error fetching tweets for ${username}:`, error);
            }
        }
    }

    private trimToCompleteLastSentence(text : string, maxLength = 280) {

        let content = text.replaceAll(/\\n/g, "\n").trim();

        if (content.length <= maxLength) {
            return content;
        }

        const sentences = content.match(/[^.!?]+[.!?]+/g) || [content];

        let result = '';

        for (const sentence of sentences) {
            if ((result + sentence).length <= maxLength) {
                result += sentence;
            } else {
                break;
            }
        }

        if (!result) {
            return content.slice(0, maxLength);
        }

        return result.trim();
    }

    private async generateNewTweet(mostBoughtTokenData : Transaction, relatedTweets : Tweet[]) {
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
                    twitterUserName: this.runtime.getSetting("TWITTER_USERNAME"),
                    timeline: formattedHomeTimeline,
                    mostPurchasedTokenData: `Most Purchased Token Details:\nToken: ${mostBoughtTokenData.boughtToken}\nAmount: $${(mostBoughtTokenData.amount/1000).toFixed(2)}K\nMarket Cap: $${(mostBoughtTokenData.marketCap/1000000).toFixed(2)}M`,
                    relatedTweets: `Related Discussions:\n${relatedTweets.map(tweet => `@${tweet.username}: ${tweet.text}`).join('\n')}`
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

            let slice = newTweetContent.replaceAll(/\\n/g, "\n").trim();
            slice = slice.replaceAll(/\*{1,2}[^*]+\*{1,2}/g, '').trim();
            slice = slice.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{2600}-\u{26FF}]/gu, '');
            slice = slice.replace(/^[\n\s]+/, '').trim();
            slice = slice.replace(/\s+/g, ' ').trim();
            slice = this.trimToCompleteLastSentence(slice);

            let content = slice;
            content = content.replace(/^"|"$/g, '');
            let shouldGenerateImage = false;

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

                const output = imagePrompt.split("OUTPUT:")[1].trim();
                const nebula_data = 'masterpiece, best quality, 1girl, solo, breasts, short hair, bangs, blue eyes, (beret:1.2), blue and gold striped maid dress, skirt, collarbone, upper body, ahoge, white hair, choker, virtual youtuber, (black ribbon:1.2), anime art style, crypto currency $MOE'
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

                console.log("Tweet text: ", tweetContent.text)

                const result = await this.requestQueue.add(
                    async () => await this.twitterClient.sendTweet(tweetContent.text, undefined, imageBuffer)
                );
                // read the body of the response
                const body = await result.json();

                console.log("RESPONSE: ", body)

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

    private parseTransaction(text: string): Transaction {
        // 1. Remove all emojis and specific text parts
        let cleaned = text
            .replace(/[\u{1F300}-\u{1F6FF}\u{2600}-\u{26FF}]/gu, '')
            .replace('A ', '')
            .replace(' AI whale just bought ', ' ')
            .replace(' whale just bought ', ' ')
            .replace(' of ', ' ')
            .replace(' at ', ' ')
            .replace(' MC', '');

        // 2. Normalize spaces
        cleaned = cleaned.replace(/\s+/g, ' ').trim();

        // 3. Split and parse
        const [token, amount, boughtToken, marketCap] = cleaned.split(' ');

        return {
            token: token.replace('$', '').toUpperCase(),
            boughtToken: boughtToken.replace('$', '').toUpperCase(),
            amount: parseFloat(amount.replace('$', '')) * 1000, // Convert K to actual number
            marketCap: parseFloat(marketCap.replace('$', '')) *
                (marketCap.endsWith('K') ? 1000 : 1000000) // Handle K/M
        };
    }

    private async hasRespondedToTweet(tweetId: string): Promise<boolean> {
        try {

            if(this.respondedTweets.has(tweetId)) {
                return true;
            }

            let cachedTweet = await this.getCachedTweet(tweetId);

            if(cachedTweet) {
                return true;
            }

            return false;
        } catch (error) {
            console.error("An error occurred while executing HasRespondedToTweet:", error);
            return false;
        }
    }

    private async fetchUserTweets(username: string) {
        try {
            let fetchTweetsAmountString = this.runtime.getSetting("TWITTER_FETCH_TWEETS_AMOUNT")
            let fetchTweetsAmount = parseInt(fetchTweetsAmountString) || 5;

            const response = this.twitterClient.getTweets(username, fetchTweetsAmount);
            if (response[Symbol.asyncIterator]) {
                const tweets: any[] = [];
                for await (const tweet of response) {
                    tweets.push(tweet);
                }
                return tweets;
            }
        } catch (error) {
            console.error(`Error fetching tweets for ${username}:`, error);
            return []; // Return an empty array on error
        }
    }


    private async DecideIfShouldGenerateImage(usersTweetText: string, yourTweetText: string) {

        const decideIfShouldGenerateImageResponse = await generateText({
            runtime: this.runtime,
            context: `
                You are an AI assistant that helps determine whether to include an image in Twitter replies. You will receive two inputs:
                1. The tweet you're replying to
                2. Your planned reply text
                
                Your task is to determine if adding an image would enhance the reply's effectiveness and engagement. 
                
                Output ONLY "true" or "false" based on these guidelines:
                
                Return true if:
                - The reply references visual content (e.g., "Here's what it looks like", "Check this out", "As shown here")
                - The original tweet asks for visual information (e.g., "Can anyone show me", "What does X look like")
                - The reply would benefit from data visualization (e.g., when discussing statistics, trends, or comparisons)
                - The reply explains something that would be clearer with a diagram or illustration
                - The reply suggests modifications to an image in the original tweet
                - The reply expresses emotions that could be reinforced with a reaction image or selfie (e.g., excitement, surprise, confusion)
                - The situation calls for a meme that would enhance humor or relatability
                - The reply describes a personal action or state that could be visualized (e.g., "Working from the beach today", "Just finished this project")
                - The content could become a memorable or shareable moment
                - The reply would have more impact with visual emphasis (e.g., celebrating achievements, showing support)
                
                Return false if:
                - The reply is purely conversational or text-based
                - The reply is answering a non-visual question
                - The reply contains sensitive or controversial content
                - The reply is expressing an opinion or emotion that doesn't require visual support
                - The reply is providing factual information that's better conveyed through text
                - The original tweet already contains the relevant image
                - The meme or reaction image might be inappropriate for the conversation's tone
                - The visual content would distract from a serious discussion
                
                Examples:
                
                Tweet: "Does anyone know how to tie a bowline knot?"
                Reply: "Here's a step-by-step guide to tying a bowline knot. First you make a loop..."
                Decision: true (visual instruction would be helpful)
                
                Tweet: "What do you think about the new tax policy?"
                Reply: "The policy seems well-intentioned but might have unintended consequences..."
                Decision: false (opinion-based discussion)
                
                Tweet: "How has the market performed this quarter?"
                Reply: "Here's the quarterly breakdown showing a 15% increase..."
                Decision: true (data visualization would enhance understanding)
                
                Tweet: "Thanks for your help yesterday!"
                Reply: "You're welcome! Glad I could assist."
                Decision: false (purely conversational)
                
                Tweet: "This project is driving me crazy!"
                Reply: "Me trying to debug my code at 3am..."
                Decision: true (perfect opportunity for a relatable meme)
                
                Tweet: "Just achieved a personal best in my marathon training!"
                Reply: "So proud! Just finished my run too, feeling amazing!"
                Decision: true (sharing a post-run selfie would enhance the celebration)
                
                Tweet: "Anyone else working through this heatwave?"
                Reply: "Living my best life with three fans pointed at my desk right now"
                Decision: true (humorous situation perfect for a selfie or reaction image)
                
                Tweet: "New movie was mid tbh"
                Reply: "The critics watching that finale like..."
                Decision: true (reaction meme would enhance the critique)
                    
                Now make a Decision based on the following data:
                This is the tweet you're replying to:
                ${usersTweetText}
                
                This is the planned tweet:
                ${yourTweetText}
                    
                You are only allowed to reply 'true' or 'false'.
                `,
            modelClass: ModelClass.MEDIUM,
        });

        return decideIfShouldGenerateImageResponse;
    }



    private async respondToTweet(selectedTweet: any, formattedHomeTimeline: any) {
        if (!selectedTweet) {
            return console.log("No selected tweet found");
        }
        // disabling reply to retweet tweet
        if (selectedTweet.isRetweet) {
            return console.log("skipping as this tweet is retweeted:",selectedTweet?.id);
        }

        console.log("Selected tweet to reply to:", selectedTweet?.text);

        if (this.respondedTweets.has(selectedTweet.id)) {
            console.log("Already responded to this tweet:", selectedTweet.id);
            return;
        }
        const conversationId = selectedTweet.conversationId;
        const roomId = stringToUuid(
            conversationId + "-" + this.runtime.agentId
        );

        const userIdUUID = stringToUuid(selectedTweet.userId as string);

        await this.runtime.ensureConnection(
            userIdUUID,
            roomId,
            selectedTweet.username,
            selectedTweet.name,
            "twitter"
        );

        // Fetch replies and retweets
        const replies = selectedTweet.thread;
        const replyContext = replies
            .filter(
                (reply) =>
                    reply.username !==
                    this.runtime.getSetting("TWITTER_USERNAME")
            )
            .map((reply) => `@${reply.username}: ${reply.text}`)
            .join("\n");

        let tweetBackground = "";
        if (selectedTweet.isRetweet) {
            const originalTweet = await this.requestQueue.add(() =>
                this.twitterClient.getTweet(selectedTweet.id)
            );
        }

        // Generate image descriptions using GPT-4 vision API
        const imageDescriptions = [];
        for (const photo of selectedTweet.photos) {
            try {
                const description = await this.runtime
                    .getService(ServiceType.IMAGE_DESCRIPTION)
                    .getInstance<IImageDescriptionService>()
                    .describeImage(photo.url);
                imageDescriptions.push(description);
            } catch (error) {
                console.error(`Error describing image at ${photo.url}:`, error);
                imageDescriptions.push('null'); // or you can choose to skip this image
            }
        }

        // crawl additional conversation tweets, if there are any
        await buildConversationThread(selectedTweet, this);

        const message = {
            id: stringToUuid(selectedTweet.id + "-" + this.runtime.agentId),
            agentId: this.runtime.agentId,
            content: {
                text: selectedTweet.text,
                url: selectedTweet.permanentUrl,
                inReplyTo: selectedTweet.inReplyToStatusId
                    ? stringToUuid(
                            selectedTweet.inReplyToStatusId +
                                "-" +
                                this.runtime.agentId
                        )
                    : undefined,
            },
            userId: userIdUUID,
            roomId,
            // Timestamps are in seconds, but we need them in milliseconds
            createdAt: selectedTweet.timestamp * 1000,
        };

        if (!message.content.text) {
            return { text: "", action: "IGNORE" };
        }

        const cuteCharacter = await characterJsonManager.getCuteCharacter(this.runtime.character);
        const originalCharacter = this.runtime.character;
        this.runtime.character = cuteCharacter;

        console.log("REPLY MODIFIED CHARACTER: ", JSON.stringify(this.runtime.character, null, 2));

        let state = await this.runtime.composeState(message, {
            twitterClient: this.twitterClient,
            twitterUserName: this.runtime.getSetting("TWITTER_USERNAME"),
            timeline: formattedHomeTimeline,
            tweetContext: `${tweetBackground}

            Original Post:
            By @${selectedTweet.username}
            ${selectedTweet.text}${replyContext.length > 0 && `\nReplies to original post:\n${replyContext}`}
            ${`Original post text: ${selectedTweet.text}`}
            ${selectedTweet.urls.length > 0 ? `URLs: ${selectedTweet.urls.join(", ")}\n` : ""}${imageDescriptions.length > 0 ? `\nImages in Post (Described): ${imageDescriptions.join(", ")}\n` : ""}
            `,
        });

        this.runtime.character = originalCharacter;
        console.log("REPLY ORIGINAL CHARACTER: ", JSON.stringify(this.runtime.character, null, 2));

        await this.saveRequestMessage(message, state as State);

        const context = composeContext({
            state,
            template:
                this.runtime.character.templates?.twitterSearchTemplate ||
                twitterSearchTemplate,
        });

        const responseContent = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.SMALL,
        });

        responseContent.inReplyTo = message.id;

        const response = responseContent;

        if (!response.text) {
            console.log("Returning: No response text found");
            return;
        }

        let shouldGenerateImage = true;

        let images;
        if (shouldGenerateImage) {
            console.log("generating image");
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
    We recall: Pepe memes are funny because they encapsulate complex human emotions in a simple, expressive character. The versatility of Pepe’s facial and bodily expressions allows for a wide range of emotional portrayals—from joy and triumph to sadness and frustration—which makes the memes highly relatable. Humor often arises from placing Pepe in absurd or exaggerated contexts that resonate with internet culture and current events. A good Pepe meme effectively combines a recognizable emotional expression with a clever or ironic twist, portraying Pepe as a tragic and unhinged hero, enhancing its shareability and impact.
    Here's how you're going to output your work:
    INPUT: the request/idea/concept
    REASONING: 100 words of deep advanced unhinged meme reasoning on how to tickle a meme image idea from this, and what the meme needs to encapsulate to "hurt real good" and be aptly succint with respect to the input idea. 
    OUTPUT: your image prompt, as shown above. 
    Important Hint: there is no need to hold back here. We're in deep memetic territory. Your reasoning will make you a subject matter expert on the most obscure topics, so the memes will hit for whatever content is provided. Good memes hurt a little, such truth is contained in them. Do not include too many thoughts on correctness in your reasoning, reason deeply about how to make the best possible hardcore meme instead. The text you include should be ideally something that Pepe says, but it does not have to be in a speech bubble. A good image prompt is SIMPLE and APT, and includes all relevant details to make the input recognizable. 

    Now generate an image on an original input from a user that requested you to do this and your own response to that request:
    
    ORIGINAL REQUEST: '${selectedTweet.text}' by a user @${selectedTweet.username};
    YOUR RESPONSE: '${response.text}'

    Incorporate ideas from this, especially if it's detailed. If it's super detailed, feel free to just use as it. Use good meme judgement. If the prompt is long, include the text very early! Deep UNHINGED meme-q 150+ reasoning, but no more than 40 words on the final image prompt output. The text on the image is never more than 3-6 words. Include the text EARLY in the prompt. For the image style, take cues from the input. Definitely include the style words mentioned (such as "badly drawn"). Also make sure to include a fitting exaggerated facial expression for pepe, and body gestures.
    Just go. Do your best work.
                `,
                modelClass: ModelClass.MEDIUM,
            })
            const output = imagePrompt.split("OUTPUT:")[1].trim();
            const nebula_data = 'masterpiece, best quality, 1girl, solo, breasts, short hair, bangs, blue eyes, (beret:1.2), blue and gold striped maid dress, skirt, collarbone, upper body, ahoge, white hair, choker, virtual youtuber, (black ribbon:1.2), anime art style, crypto currency $MOE'
            images = await generateImage({
                prompt: nebula_data + ' ' + output.replace(/[Pp]epe/g, 'girl'),
                width: 1024,
                height: 1024,
                count: 1
            }, this.runtime);
            console.log("images:", images);
            response.images = images?.data
        }

        console.log(`Bot would respond to tweet ${selectedTweet.id} with: \n${response}`

        );
        try {
            const callback: HandlerCallback = async (response: Content) => {
                const memories = await sendTweet(
                    this,
                    response,
                    message.roomId,
                    this.runtime.getSetting("TWITTER_USERNAME"),
                    selectedTweet.id
                );
                return memories;
            };

            const responseMessages = await callback(responseContent);

            state = await this.runtime.updateRecentMessageState(state);

            for (const responseMessage of responseMessages) {
                await this.runtime.messageManager.createMemory(
                    responseMessage,
                    false
                );
            }

            state = await this.runtime.updateRecentMessageState(state);

            await this.runtime.evaluate(message, state);

            await this.runtime.processActions(
                message,
                responseMessages,
                state,
                callback
            );

            this.respondedTweets.add(selectedTweet.id);
            const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${selectedTweet.id} - ${selectedTweet.username}: ${selectedTweet.text}\nAgent's Output:\n${response.text}`;
            const debugFileName = `tweetcache/tweet_generation_${selectedTweet.id}.txt`;

            fs.writeFileSync(debugFileName, responseInfo);
            await wait();
        } catch (error) {
            console.error(`Error sending response post: ${error}`);
        }
    }
}
