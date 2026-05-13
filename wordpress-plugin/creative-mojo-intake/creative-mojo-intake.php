<?php
/**
 * Plugin Name: Creative Mojo Form Intake
 * Plugin URI:  https://creativemojo.co.uk
 * Description: Forwards Gravity Forms submissions (general / franchise / licence enquiries) into the Creative Mojo Admin CRM. Replaces Zapier with a direct, free pipeline.
 * Version:     1.0.0
 * Author:      Creative Mojo
 * Author URI:  https://creativemojo.co.uk
 * License:     GPLv2 or later
 * Requires PHP: 7.4
 */

if (!defined('ABSPATH')) {
    exit;
}

class CMojo_Intake_Plugin {

    const OPTION_KEY = 'cmojo_intake_settings';
    const LOG_OPTION = 'cmojo_intake_log';
    const MAX_LOG_ENTRIES = 25;

    public function __construct() {
        add_action('admin_menu', [$this, 'register_settings_page']);
        add_action('admin_init', [$this, 'register_settings']);
        // Generic Gravity Forms hook (fires after every submission)
        add_action('gform_after_submission', [$this, 'on_form_submission'], 10, 2);
    }

    public function register_settings_page() {
        add_options_page(
            'Creative Mojo Intake',
            'Creative Mojo Intake',
            'manage_options',
            'cmojo-intake',
            [$this, 'render_settings_page']
        );
    }

    public function register_settings() {
        register_setting(self::OPTION_KEY, self::OPTION_KEY, [$this, 'sanitize_settings']);
    }

    public function sanitize_settings($input) {
        return [
            'endpoint_url' => isset($input['endpoint_url']) ? esc_url_raw(trim($input['endpoint_url'])) : '',
            'intake_token' => isset($input['intake_token']) ? sanitize_text_field(trim($input['intake_token'])) : '',
            'enabled_form_ids' => isset($input['enabled_form_ids']) ? sanitize_text_field(trim($input['enabled_form_ids'])) : '1,17,32',
        ];
    }

    public function get_settings() {
        $defaults = ['endpoint_url' => '', 'intake_token' => '', 'enabled_form_ids' => '1,17,32'];
        return array_merge($defaults, (array) get_option(self::OPTION_KEY, []));
    }

    /**
     * Fires when a Gravity Form is submitted.
     * @param array $entry Gravity Forms entry array
     * @param array $form  Gravity Forms form definition
     */
    public function on_form_submission($entry, $form) {
        $settings = $this->get_settings();

        if (empty($settings['endpoint_url']) || empty($settings['intake_token'])) {
            $this->log('skipped', $form['id'] ?? 0, 'Plugin not configured (missing endpoint or token)');
            return;
        }

        $enabled_ids = array_map('intval', array_filter(array_map('trim', explode(',', $settings['enabled_form_ids']))));
        $form_id = isset($form['id']) ? intval($form['id']) : 0;
        if (!empty($enabled_ids) && !in_array($form_id, $enabled_ids, true)) {
            $this->log('skipped', $form_id, 'Form ID not in enabled list');
            return;
        }

        // Build a label → value map from form fields + entry
        $fields_by_label = [];
        if (!empty($form['fields']) && is_array($form['fields'])) {
            foreach ($form['fields'] as $field) {
                $label = isset($field->label) ? (string) $field->label : '';
                if ($label === '') continue;

                // Composite name field: pull each sub-input
                if (!empty($field->inputs) && is_array($field->inputs)) {
                    foreach ($field->inputs as $input) {
                        $sub_id = (string) $input['id'];
                        $sub_label = isset($input['label']) ? trim($input['label']) : '';
                        $value = isset($entry[$sub_id]) ? (string) $entry[$sub_id] : '';
                        if ($value === '') continue;
                        // e.g. "First" or "Last" within a Name field
                        if ($sub_label !== '') {
                            $fields_by_label[$sub_label] = $value;
                            // Also store as "First Name" / "Last Name" for easier mapping
                            $fields_by_label[trim($sub_label . ' Name')] = $value;
                        }
                    }
                } else {
                    $field_id = (string) $field->id;
                    $value = isset($entry[$field_id]) ? (string) $entry[$field_id] : '';
                    if ($value !== '') {
                        $fields_by_label[$label] = $value;
                    }
                }
            }
        }

        $payload = [
            'form_id'    => $form_id,
            'form_title' => isset($form['title']) ? (string) $form['title'] : '',
            'entry_id'   => isset($entry['id']) ? (string) $entry['id'] : '',
            'date'       => isset($entry['date_created']) ? (string) $entry['date_created'] : '',
            'fields'     => $fields_by_label,
            'raw'        => [
                'source_url' => isset($entry['source_url']) ? (string) $entry['source_url'] : '',
                'ip'         => isset($entry['ip']) ? (string) $entry['ip'] : '',
                'user_agent' => isset($entry['user_agent']) ? (string) $entry['user_agent'] : '',
            ],
        ];

        $response = wp_remote_post($settings['endpoint_url'], [
            'timeout'  => 15,
            'blocking' => true,
            'headers'  => [
                'Content-Type'   => 'application/json',
                'X-Intake-Token' => $settings['intake_token'],
            ],
            'body'     => wp_json_encode($payload),
        ]);

        if (is_wp_error($response)) {
            $this->log('error', $form_id, 'HTTP error: ' . $response->get_error_message());
            return;
        }

        $code = wp_remote_retrieve_response_code($response);
        $body = wp_remote_retrieve_body($response);

        if ($code >= 200 && $code < 300) {
            $this->log('success', $form_id, "Sent to CRM (HTTP $code)");
        } else {
            $this->log('error', $form_id, "HTTP $code: " . substr($body, 0, 200));
        }
    }

    private function log($status, $form_id, $message) {
        $log = (array) get_option(self::LOG_OPTION, []);
        array_unshift($log, [
            'time'    => current_time('mysql'),
            'status'  => $status,
            'form_id' => $form_id,
            'message' => $message,
        ]);
        $log = array_slice($log, 0, self::MAX_LOG_ENTRIES);
        update_option(self::LOG_OPTION, $log, false);
    }

    public function render_settings_page() {
        if (!current_user_can('manage_options')) return;
        $settings = $this->get_settings();
        $log = (array) get_option(self::LOG_OPTION, []);
        ?>
        <div class="wrap">
            <h1>Creative Mojo Form Intake</h1>
            <p>Forwards Gravity Forms submissions to the Creative Mojo Admin CRM.</p>

            <form method="post" action="options.php">
                <?php settings_fields(self::OPTION_KEY); ?>
                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row"><label for="cmojo_endpoint">Endpoint URL</label></th>
                        <td>
                            <input type="url" id="cmojo_endpoint" name="<?php echo esc_attr(self::OPTION_KEY); ?>[endpoint_url]"
                                   value="<?php echo esc_attr($settings['endpoint_url']); ?>"
                                   class="regular-text" placeholder="https://your-admin.example.com/api/intake/gravity-forms" />
                            <p class="description">Paste the endpoint URL shown in the Creative Mojo Admin → Form Intake page.</p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="cmojo_token">Intake Token</label></th>
                        <td>
                            <input type="text" id="cmojo_token" name="<?php echo esc_attr(self::OPTION_KEY); ?>[intake_token]"
                                   value="<?php echo esc_attr($settings['intake_token']); ?>"
                                   class="regular-text" placeholder="cm_intake_..." />
                            <p class="description">The shared secret from the Creative Mojo Admin → Form Intake page. Treat like a password.</p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="cmojo_forms">Enabled Form IDs</label></th>
                        <td>
                            <input type="text" id="cmojo_forms" name="<?php echo esc_attr(self::OPTION_KEY); ?>[enabled_form_ids]"
                                   value="<?php echo esc_attr($settings['enabled_form_ids']); ?>"
                                   class="regular-text" />
                            <p class="description">Comma-separated Gravity Forms IDs to forward. Default: <code>1,17,32</code> (Contact, Franchise Enquiry, Licence Enquiry).</p>
                        </td>
                    </tr>
                </table>
                <?php submit_button('Save settings'); ?>
            </form>

            <h2 style="margin-top: 2em;">Recent activity</h2>
            <?php if (empty($log)): ?>
                <p><em>No submissions forwarded yet. Submit a test form to see activity here.</em></p>
            <?php else: ?>
                <table class="widefat striped" style="max-width: 900px;">
                    <thead>
                        <tr>
                            <th style="width: 160px;">Time</th>
                            <th style="width: 80px;">Form ID</th>
                            <th style="width: 100px;">Status</th>
                            <th>Message</th>
                        </tr>
                    </thead>
                    <tbody>
                        <?php foreach ($log as $entry): ?>
                            <tr>
                                <td><?php echo esc_html($entry['time']); ?></td>
                                <td><?php echo esc_html($entry['form_id']); ?></td>
                                <td>
                                    <?php
                                    $color = $entry['status'] === 'success' ? '#4caf50' : ($entry['status'] === 'error' ? '#f44336' : '#9e9e9e');
                                    echo '<strong style="color:' . esc_attr($color) . '">' . esc_html(strtoupper($entry['status'])) . '</strong>';
                                    ?>
                                </td>
                                <td><?php echo esc_html($entry['message']); ?></td>
                            </tr>
                        <?php endforeach; ?>
                    </tbody>
                </table>
                <p>
                    <a href="<?php echo esc_url(add_query_arg('cmojo_clear_log', 1)); ?>" onclick="return confirm('Clear the activity log?')">Clear log</a>
                </p>
                <?php
                if (isset($_GET['cmojo_clear_log'])) {
                    delete_option(self::LOG_OPTION);
                    echo '<div class="notice notice-success"><p>Log cleared.</p></div>';
                }
                ?>
            <?php endif; ?>

            <h2 style="margin-top: 2em;">How it works</h2>
            <ol>
                <li>Plugin listens for any Gravity Forms submission.</li>
                <li>If the form ID is in your enabled list, it POSTs the form data (as a label → value map) to the Endpoint URL with the Intake Token in the <code>X-Intake-Token</code> header.</li>
                <li>The CRM creates a new enquiry record tagged by form ID (general / franchise / licence) and adds it to the sales pipeline.</li>
                <li>If anything fails, the error is logged above so you can see what happened.</li>
            </ol>

            <h2 style="margin-top: 2em;">Removing this plugin</h2>
            <p>Simply deactivate or delete it via Plugins → Installed Plugins. Your forms will continue working exactly as they did before, just without forwarding to the CRM.</p>
        </div>
        <?php
    }
}

new CMojo_Intake_Plugin();
